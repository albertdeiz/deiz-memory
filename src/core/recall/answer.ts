import type { Actor } from '../domain/types';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { askFacts, type FactHit } from '../facts/query';
import { checkGrounding } from './grounding';
import { retrieve, type Passage, type RetrieveInput } from './retrieve';

/**
 * Answering a question with what you stored.
 *
 * Two invariants rule here:
 *
 *   1. Never answer a factual question without a memory id backing it.
 *   2. If it is not stored, the correct answer is "I do not have it" — not a
 *      plausible inference.
 *
 * So the model does not answer from its own knowledge: it answers **only** over
 * the retrieved passages, and every claim has to point at one. An answer with
 * no citation is discarded before it is ever shown.
 */
export interface AnswerInput extends RetrieveInput {
  /** Without this the raw passages come back, which is already useful and free. */
  synthesize?: boolean;
}

export interface Answer {
  /** The prose answer, or null when it could not be answered from what is stored. */
  text: string | null;
  /** The passages it rests on. Always present, even with no prose. */
  sources: Passage[];
  /** Why there is no answer, when there is none. */
  reason: 'no_results' | 'no_model' | 'no_citation' | 'ungrounded' | null;
  /**
   * The typed data that answers, when it exists.
   *
   * When these come back they are **the** answer: they come from a query, not a
   * ranking, and there is no prose to verify. Presentation shows them instead of
   * the search, not in addition to it.
   */
  facts?: FactHit[];
}

/**
 * How many passages the model gets.
 *
 * Eight, which is what retrieval returns by default: cutting at six left an
 * arbitrary cliff between what is retrieved and what is read, and a question
 * whose answer landed seventh got a "I do not have it".
 */
const MAX_PASSAGES = 8;

export async function answer(
  deps: Deps,
  actor: Actor,
  input: AnswerInput,
): Promise<Result<Answer>> {
  // 1 · Fact mode first. If a typed field answers, there is nothing to rank:
  //     the answer is exact, with its validity window and its citation. Falls
  //     through to search mode silently when it does not apply, which is most
  //     of the time.
  const hits = await askFacts(deps.db, actor, input.query, deps.clock?.now() ?? new Date());
  if (hits.length > 0) {
    return ok({ text: null, sources: [], reason: null, facts: hits });
  }

  const found = await retrieve(deps, actor, input);
  if (!found.ok) return found;
  const sources = found.value;

  if (sources.length === 0) {
    // "I do not have it" is a correct and frequent answer, and worth measuring.
    return ok({ text: null, sources: [], reason: 'no_results' });
  }
  if (!input.synthesize || !deps.classifier) {
    return ok({ text: null, sources: dedupe(sources), reason: input.synthesize ? 'no_model' : null });
  }

  const used = sources.slice(0, MAX_PASSAGES);
  const context = used
    .map((p, i) => `[${i + 1}] ${p.title ?? 'sin título'} (${dateOf(p)})\n${p.content}`)
    .join('\n\n---\n\n');

  // Short and in order of importance, not exhaustive.
  //
  // The first version listed seven rules — including no medical advice and how
  // to handle contradictory fragments — and a 3B model answered "I do not have
  // it" to a question the fragments answered. With the same context and these
  // four lines it answers correctly. To a small model, a long list of
  // restrictions reads as "better not to risk it".
  //
  // What was removed was not lost: not inventing and not exceeding what is
  // stored are verified in code below, which is where it can actually be
  // guaranteed.
  const system = [
    'Respondes con los fragmentos que te doy.',
    'Da el dato concreto en una o dos frases, no un resumen.',
    'Copia números, montos y fechas exactos.',
    'Solo si ninguno de los fragmentos toca el tema, responde NO_LO_TENGO.',
    '',
    // The example is shown, not just described. Without it a small model cites
    // in prose — "it is in the first fragment" — which is a citation for a human
    // and not for the code that has to resolve it to an id.
    'Termina cada frase con el número del fragmento entre corchetes. Así:',
    'El deducible es de 5 UF por siniestro [1].',
  ].join('\n');

  const draft = (await deps.classifier.complete({
    system,
    user: `Fragmentos:\n\n${context}\n\n---\n\nPregunta: ${input.query}`,
  })).trim() || null;
  if (!draft || /NO_LO_TENGO/i.test(draft)) {
    // The model says it is not there. Believe it: that is the invariant.
    return ok({ text: null, sources: dedupe(sources), reason: 'no_results' });
  }

  // Citation required, verified rather than trusted: a factual answer with no
  // citation is not shown. The prompt asking for one does not guarantee it.
  //
  // One retry before discarding, because the typical failure is not inventing:
  // it is citing in prose, which serves a person and not the code that has to
  // resolve it to an id.
  let cited = draft;
  if (!/\[\d+\]/.test(cited)) {
    const retry = (await deps.classifier.complete({
      system: 'Reescribe la respuesta poniendo el número del fragmento entre corchetes al final de cada frase. No cambies ningún dato.',
      user: `Fragmentos:\n\n${context}\n\n---\n\nRespuesta a corregir: ${cited}`,
    })).trim();
    if (/\[\d+\]/.test(retry)) cited = retry;
    else return ok({ text: null, sources: dedupe(sources), reason: 'no_citation' });
  }

  const resolved = resolveCitations(cited, used);

  // Also verified rather than trusted: a figure that is not in what was read is
  // not shown, however impeccable its citation.
  const grounding = checkGrounding(resolved, used.map((p) => p.content));
  if (!grounding.ok) {
    return ok({ text: null, sources: dedupe(used), reason: 'ungrounded' });
  }

  // Sources are reordered so the ones the answer actually cited come first.
  // Otherwise "view 1" opens a document the datum did not come from, which is
  // worse than not offering the button.
  const citedIds = new Set(
    [...resolved.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1]!),
  );
  const ordered = [
    ...used.filter((p) => citedIds.has(p.shortId)),
    ...used.filter((p) => !citedIds.has(p.shortId)),
  ];

  return ok({ text: resolved, sources: dedupe(ordered), reason: null });
}

/**
 * One source per memory, keeping the best passage of each.
 *
 * The model does read several chunks of the same document — that is what
 * chunking is for — but showing them as distinct sources is an interface lie:
 * the same policy appeared three times in a row, which in chat means "view 1",
 * "view 2" and "view 3" open exactly the same file.
 *
 * Done here and not in retrieval on purpose: retrieving per chunk is right,
 * presenting per chunk is not. The input order is already decided — by score,
 * with the cited ones in front — so keeping the first of each memory preserves
 * that decision.
 */
function dedupe(passages: Passage[]): Passage[] {
  const seen = new Set<string>();
  return passages.filter((p) => {
    if (seen.has(p.memoryId)) return false;
    seen.add(p.memoryId);
    return true;
  });
}

const dateOf = (p: Passage): string =>
  (p.occurredAt ?? p.capturedAt).toISOString().slice(0, 10);

/**
 * Replaces [1] with the memory's short id.
 *
 * A bracketed number is worth nothing half an hour later; an id is, and it
 * opens the document. The citation has to lead somewhere.
 */
function resolveCitations(text: string, sources: Passage[]): string {
  return text.replace(/\[(\d+)\]/g, (m, n) => {
    const p = sources[Number(n) - 1];
    return p ? `[${p.shortId}]` : m;
  });
}
