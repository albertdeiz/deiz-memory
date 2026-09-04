import type { MemoryDetail, MemorySummary } from '../../core/domain/types';
import type { ReviewItem } from '../../core/ops/review';
import type { Answer } from '../../core/recall/answer';
import { conflicting, contextOf, renderValue, warningFor } from '../../core/facts/format';
import type { FactHit } from '../../core/facts/query';
import type { Result } from '../../core/result';
import { meaningfulName } from '../../core/filenames';

/**
 * One of the only two places prose lives. The core does not know it exists:
 * it returns data and this file decides how it looks.
 */
const KB = 1024;
export const humanSize = (bytes: number | null): string => {
  if (bytes === null) return '—';
  if (bytes < KB) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / KB;
  let i = 0;
  while (v >= KB && i < units.length - 1) { v /= KB; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

export const humanDate = (d: Date | null): string =>
  d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';

const KINDS: [string, string][] = [
  ['application/pdf', 'PDF'], ['image/', 'foto'], ['audio/', 'audio'],
  ['video/', 'video'], ['text/', 'texto'],
];

const kindOf = (mediaType: string | null): string => {
  const hit = KINDS.find(([prefix]) => mediaType?.startsWith(prefix));
  return hit ? hit[1] : 'file';
};

/**
 * A camera or messenger filename is not a title: content is preferred before
 * falling back to it. With no content either, say what it is instead of lying.
 */
const label = (m: MemorySummary): string =>
  m.title ?? meaningfulName(m.originalFilename) ?? m.excerpt ?? `(${kindOf(m.mediaType)} sin nombre)`;

export function renderList(items: MemorySummary[]): string {
  if (items.length === 0) return 'Nada guardado todavía.';
  return items
    .map((m) => {
      const flags = m.hidden ? ' [oculta]' : '';
      const size = m.sizeBytes === null ? '' : `  ${humanSize(m.sizeBytes)}`;
      return `${m.shortId}  ${humanDate(m.capturedAt)}  ${label(m)}${size}${flags}`;
    })
    .join('\n');
}

/** How the file was read. Shown in the detail because it sets expectations. */
const LANE_LABEL: Record<string, string> = {
  text: 'leído tal cual',
  document: 'markitdown',
  vision: 'transcrito de la imagen',
  audio: 'transcrito del audio',
  none: 'sin carril',
};

export function renderDetail(m: MemoryDetail): string {
  const lines = [
    `id         ${m.id}`,
    `capturada  ${humanDate(m.capturedAt)}`,
    `ocurrió    ${humanDate(m.occurredAt)}`,
    `origen     ${m.source}`,
    `estado     ${m.status}${m.hidden ? ' · oculta' : ''}`,
  ];
  if (m.title) lines.push(`título     ${m.title}`);
  if (m.originalFilename) lines.push(`archivo    ${m.originalFilename}`);
  if (m.mediaType) lines.push(`tipo       ${m.mediaType}  ${humanSize(m.sizeBytes)}`);
  if (m.sha256) lines.push(`sha256     ${m.sha256}`);

  if (m.lane) {
    const how = LANE_LABEL[m.lane] ?? m.lane;
    lines.push(`carril     ${m.lane} · ${how}  ${humanDate(m.normalizedAt)}`);
  } else if (m.sha256) {
    lines.push('carril     todavía sin normalizar — corre dm worker');
  }

  // The error goes before the text and not after: if what follows is incomplete,
  // enterarse al final es enterarse tarde.
  if (m.normalizationError) lines.push(`⚠ carril    ${m.normalizationError}`);

  // The two sources are shown separately and labelled. Merging them would leave
  // the person unable to tell what they wrote from what a machine read off paper
  // — which is exactly the difference between a datum and a guess.
  if (m.note) lines.push('', 'tu nota:', m.note);
  if (m.normalizedText) lines.push('', 'del archivo:', m.normalizedText);
  return lines.join('\n');
}

/**
 * The review inbox.
 *
 * What matters here is not the list: it is that each line says **what to do**.
 * An inbox that enumerates problems without saying which a retry fixes and
 * which needs something else leaves you exactly where you started.
 */
export function renderReview(items: ReviewItem[]): string {
  if (items.length === 0) return 'Nada que revisar.';

  const lines = items.map((m) => {
    const que = m.title ?? meaningfulName(m.originalFilename) ?? `(${kindOf(m.mediaType)} sin nombre)`;
    const salvado = m.chars > 0 ? `  · quedaron ${m.chars} caracteres` : '  · sin texto';
    const accion =
      m.retryable === true ? 'reintentar sirve  → dm reprocess ' + m.shortId
      : m.retryable === false ? 'reintentar NO sirve: necesita otro carril o convertir el archivo'
      : 'no se sabe si sirve reintentar (falló antes de que el sistema distinguiera)';
    return [
      `${m.shortId}  ${humanDate(m.capturedAt)}  ${que}${salvado}`,
      `           ${m.error}`,
      `           ${accion}`,
    ].join('\n');
  });

  const retryable = items.filter((m) => m.retryable === true).length;
  const unclassified = items.filter((m) => m.retryable === null).length;

  // Saying "none of these a retry can fix" when it is not actually known would
  // be exactly the kind of false claim this inbox exists to prevent. With no
  // datum, it says there is no datum.
  const cola =
    retryable > 0
      ? `\n\n${retryable} de ${items.length} se pueden reintentar: dm reprocess --failed`
      : unclassified === items.length
        ? '\n\nTodavía no sé cuáles se arreglan reintentando; corre dm reprocess --failed --yes una vez y lo sabré.'
        : unclassified > 0
          ? `\n\nNinguna de las clasificadas se arregla reintentando (${unclassified} sin clasificar).`
          : '\n\nNinguna se arregla reintentando.';

  return lines.join('\n\n') + cola;
}

/**
 * An answer with its sources.
 *
 * Sources are NOT optional or decorative: no factual datum is answered without
 * a memory backing it, so they are always shown — even when there was no prose
 * — and each carries its id so it can be opened.
 */
export function renderAnswer(a: Answer): string {
  // Fact mode: the exact datum, not a list of documents to look through.
  if (a.facts?.length) return renderFacts(a.facts);

  const fuentes = a.sources.map((p) => {
    const cuando = (p.occurredAt ?? p.capturedAt).toISOString().slice(0, 10);
    const donde = p.domainLabel ? ` · ${p.domainLabel}` : '';
    const frag = p.content.replace(/\s+/g, ' ').trim();
    return `  ${p.shortId}  ${cuando}${donde}  ${p.title ?? '(sin título)'}\n` +
           `      ${frag.length > 160 ? frag.slice(0, 159) + '…' : frag}`;
  });

  if (a.text) return `${a.text}\n\nfuentes:\n${fuentes.join('\n')}`;

  switch (a.reason) {
    case 'no_results':
      return 'No lo tengo.';
    case 'no_citation':
      // The prose was discarded on purpose: an answer with no citation does not
      // qualify. Raw passages beat an unbacked claim.
      return `No pude responderlo sin inventar, pero esto es lo que encontré:\n${fuentes.join('\n')}`;
    case 'ungrounded':
      // There was prose and it was discarded: it asserted a figure absent from
      // what it read. An invented number with a valid citation is the worst
      // possible failure here, because nothing gives it away.
      return `No pude darte la cifra sin inventarla. Esto es lo que encontré:\n${fuentes.join('\n')}`;
    case 'no_model':
      return `Sin modelo para redactar. Lo que encontré:\n${fuentes.join('\n')}`;
    default:
      return fuentes.join('\n');
  }
}

/**
 * The hard data that answered.
 *
 * **The warning goes before the value.** Reading "3 UF" and only then
 * "expired in 2024" is exactly the failure mode this exists to prevent:
 * el riesgo no es olvidar un dato, es leer el viejo sin darte cuenta.
 */
function renderFacts(hits: FactHit[]): string {
  const lineas = hits.map((h) => {
    const aviso = warningFor(h);
    const cabeza = aviso ? `⚠ ${aviso}. ` : '';
    return [
      `${cabeza}${h.ref.field.label}: ${renderValue(h.value, h.ref.field.kind)}`,
      `    ${contextOf(h)} · ${h.fact.shortId}`,
    ].join('\n');
  });
  // Two live copies of the same datum are not resolved by picking one.
  const conflicto = conflicting(hits)
    ? '\n\nHay dos vigentes que dicen cosas distintas. No elijo por ti.'
    : '';
  return lineas.join('\n') + conflicto;
}

/** Errors and confirmations: what happened and what to do, without apology. */
export function renderFailure(result: Extract<Result<unknown>, { ok: false }>): string {
  if (result.kind === 'requires_confirmation') {
    const affected = result.affects.map((a) => `  · ${a.label ?? a.id}`).join('\n');
    return `${result.message}\n${affected}\n\nRepite con --yes si es lo que quieres.`;
  }
  const detail = result.detail as { matches?: string[] } | undefined;
  if (result.kind === 'ambiguous' && detail?.matches) {
    return `${result.message}\n${detail.matches.map((m) => `  · ${m}`).join('\n')}`;
  }
  return result.message;
}
