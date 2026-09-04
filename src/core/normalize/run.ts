import type { Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import { looksLikeText } from '../media';
import type { Converter, Deps, ExtractInput } from '../ports';
import { err, isPermanent, ok, type Result } from '../result';
import { canonical, clamp, isPoor, lanesFor, type Lane } from './lanes';

/** What was tried and how it went. This is what makes a reprocess legible months later. */
export interface Attempt {
  lane: Lane;
  ok: boolean;
  detail: string;
}

export interface NormalizeOutcome {
  id: Uuid;
  shortId: string;
  lane: Lane;
  chars: number;
  error: string | null;
  attempts: Attempt[];
  /** The category the classifier assigned, or null if it assigned none. */
  domain?: string | null;
}

/**
 * Reading a text file needs no tool: the cheapest lane, and the only one that
 * can never be missing. It lives here rather than in capture() so reprocessing a
 * .txt takes exactly the same path as reprocessing a PDF.
 */
const textConverter: Converter = {
  async extract({ bytes }: ExtractInput) {
    if (!looksLikeText(bytes)) throw new Error('los bytes no son texto legible');
    const decoded = bytes.toString('utf8');
    if (decoded.includes('�')) throw new Error('el archivo no viene en UTF-8');
    return { text: decoded, detail: { encoding: 'utf-8' } };
  },
  async available() {
    return { ok: true, detail: 'no necesita nada' };
  },
};

const converterFor = (deps: Deps, lane: Lane): Converter | null => {
  if (lane === 'text') return textConverter;
  if (lane === 'document') return deps.converters.document;
  if (lane === 'vision') return deps.converters.vision;
  if (lane === 'audio') return deps.converters.audio;
  return null;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Row {
  id: string;
  blob_sha256: string | null;
  original_filename: string | null;
  media_type: string | null;
  storage_key: string | null;
}

/**
 * Runs the lanes over a memory and stores whatever comes out.
 *
 * It takes no actor on purpose: the worker calls it, processing whatever it was
 * handed by id. Every path that starts with a person resolves against their
 * owner first and only then arrives here.
 *
 * It never throws because a lane failed. A failure is stored on the row and
 * waits for an explicit reprocess. Throwing would leave the memory in a limbo
 * where the worker retries it forever.
 */
export async function normalizeMemory(deps: Deps, memoryId: Uuid): Promise<Result<NormalizeOutcome>> {
  const { rows } = await deps.db.query<Row>(
    `select m.id, m.blob_sha256, m.original_filename, b.media_type, b.storage_key
       from memories m left join blobs b on b.sha256 = m.blob_sha256
      where m.id = $1`,
    [memoryId],
  );
  if (rows.length === 0) return err('not_found', `No existe la memoria ${memoryId}.`);

  const row = rows[0]!;
  const id = row.id;
  const short = shortId(id);

  // Note only: there is no blob to derive anything from, and that is not a
  // failure. It still has to be indexed, though — what you typed by hand must be
  // as searchable as what was read out of a PDF. Leaving through here without
  // indexing kept every bare note out of the answers, silently.
  if (!row.blob_sha256 || !row.storage_key) {
    await save(deps, id, { text: null, lane: 'none', error: null, detail: { reason: 'memoria sin archivo' } });
    const domain = await finish(deps, id);
    return ok({ id, shortId: short, lane: 'none', chars: 0, error: null, attempts: [], domain });
  }

  const candidates = lanesFor(row.media_type);
  if (candidates.length === 0) {
    const detail = { reason: 'sin carril', mediaType: row.media_type };
    await save(deps, id, { text: null, lane: 'none', error: null, detail });
    // No lane means no extracted text, but there can still be a note — and that
    // note has to be as searchable and as classifiable as a PDF.
    const domain = await finish(deps, id);
    return ok({ id, shortId: short, lane: 'none', chars: 0, error: null, attempts: [], domain });
  }

  let bytes: Buffer;
  try {
    bytes = await deps.blobs.get(row.storage_key);
  } catch (e) {
    // The blob is the only irrecoverable thing: if it is gone there is nothing
    // to reprocess, and that deserves shouting, not another failed-lane note.
    await save(deps, id, { text: null, lane: 'none', error: `no se pudo leer el original: ${message(e)}`, detail: {} });
    return err('not_found', `El original de ${short} no está en el storage: ${message(e)}`);
  }

  const input: ExtractInput = {
    bytes,
    mediaType: row.media_type!,
    filename: row.original_filename,
  };

  const attempts: Attempt[] = [];
  let best: { text: string; lane: Lane; detail: Record<string, unknown>; incomplete?: string } | null = null;
  let unfinished: string | null = null;
  // Starts false and only opens up: if ANY lane failed for something transient,
  // retrying may help. Every path has to be closed before saying it will not.
  let retryable = false;
  let anyFailure = false;

  for (const lane of candidates) {
    const converter = converterFor(deps, lane);
    if (!converter) {
      attempts.push({ lane, ok: false, detail: 'carril no configurado' });
      unfinished ??= `el carril "${lane}" no está configurado`;
      anyFailure = true;
      // Configuring a lane means changing the environment, not retrying. But
      // once configured a reprocess does help, so it counts as something that
      // gets fixed without touching code.
      retryable = true;
      continue;
    }
    try {
      const out = await converter.extract(input);
      const text = out.text ?? '';
      attempts.push({ lane, ok: true, detail: `${text.trim().length} caracteres` });
      if (!best || text.trim().length > best.text.trim().length) {
        best = { text, lane, detail: out.detail ?? {}, ...(out.incomplete ? { incomplete: out.incomplete } : {}) };
        // This lane beat everything before it, so an earlier failure no longer
        // explains the result. Without forgetting it, a receipt read perfectly
        // by OCR stayed flagged "the document lane is not configured" only
        // because that lane never ran — and it had nothing to contribute to a
        // scan anyway.
        if (text.trim().length > 0) unfinished = null;
      }
      // Enough text: no reason to pay for the next lane.
      if (!isPoor(text)) {
        unfinished = null;
        break;
      }
    } catch (e) {
      attempts.push({ lane, ok: false, detail: message(e) });
      unfinished ??= `el carril "${lane}" falló: ${message(e)}`;
      anyFailure = true;
      if (!isPermanent(e)) retryable = true;
    }
  }

  // A poor result with a lane still pending is not a success: what there is gets
  // stored, but flagged so a later reprocess picks it up once the missing lane
  // exists.
  const poor = isPoor(best?.text);
  const error = best === null
    ? (unfinished ?? 'ningún carril produjo texto')
    // Incomplete text is not a success however long it is: stored, stated, and
    // selectable by a later reprocess.
    : (best.incomplete ?? (poor && unfinished ? unfinished : null));

  const clamped = best ? clamp(canonical(best.text)) : { text: '', truncated: false };
  const finalText = clamped.text.trim() || null;

  await save(deps, id, {
    text: finalText,
    lane: best?.lane ?? 'none',
    error,
    // Incomplete or low-confidence text did not fail: the lane did what it
    // could. Retrying would give exactly the same, so it is not retryable
    // either — what it needs is another lane, or human eyes.
    retryable: error === null ? null : anyFailure ? retryable : false,
    detail: { ...(best?.detail ?? {}), attempts, ...(clamped.truncated ? { truncated: true } : {}) },
  });

  // Indexing belongs here and not in a separate step: chunks derive from the
  // text, so every time the text changes they have to be rebuilt or search keeps
  // answering with the old one. Failing does not invalidate normalization.
  //
  // Done with or without an embedder: full-text search runs over the chunks too,
  // so without them there is nothing to search by either path.
  const domain = await finish(deps, id);

  return ok({
    id,
    shortId: short,
    lane: best?.lane ?? 'none',
    chars: finalText?.length ?? 0,
    error,
    attempts,
    domain,
  });
}

/**
 * What follows storing the text: making it searchable and classified.
 *
 * Either one failing does not invalidate normalization — the text is already on
 * the row, and the text is the expensive thing to recover.
 */
async function finish(deps: Deps, id: Uuid): Promise<string | null> {
  await reindex(deps, id);
  const classified = await reclassify(deps, id);
  // Classifying already extracts, because the domain decides which extractors
  // apply. This only covers the case where it did not classify — a memory that
  // already had a category, being reprocessed — so a reprocess rebuilds facts too.
  if (!classified.ran) await reextract(deps, id);
  return classified.domain;
}

/**
 * The hard data, if the document has any.
 *
 * Last, and harmless when it fails: a fact is one more derived thing, and the
 * text — the expensive part — is already stored.
 */
async function reextract(deps: Deps, id: Uuid): Promise<void> {
  if (!deps.classifier) return;
  const { rows } = await deps.db.query<{ owner_id: string }>(
    `select owner_id from memories where id = $1`, [id],
  );
  const ownerId = rows[0]?.owner_id;
  if (!ownerId) return;
  const { extractFacts } = await import('../facts/extract');
  await extractFacts(deps, { ownerId }, id).catch(() => {});
}

/**
 * Domain, short title and date of the event.
 *
 * **This call was missing, and it is why no domain had any memories.** The
 * classifier worked and was tested, but only the manual command ever called it:
 * everything arriving through chat stayed normalized, indexed and uncategorized
 * forever. The work was considered done because the command ran, and nobody
 * asked who ran it.
 *
 * It does not overwrite a category already set: reprocessing improves the text,
 * it does not revisit decisions. Reclassifying on purpose is its own command.
 */
async function reclassify(
  deps: Deps,
  id: Uuid,
): Promise<{ ran: boolean; domain: string | null }> {
  if (!deps.classifier) return { ran: false, domain: null };
  const { rows } = await deps.db.query<{ owner_id: string; domain_id: string | null }>(
    `select owner_id, domain_id from memories where id = $1`, [id],
  );
  const m = rows[0];
  if (!m || m.domain_id) return { ran: false, domain: null };

  const { classifyMemory } = await import('../classify/run');
  const r = await classifyMemory(deps, { ownerId: m.owner_id }, id).catch(() => null);
  return { ran: true, domain: r?.ok ? r.value.domain : null };
}

/** Rebuilds the chunks. Failing does not invalidate normalization. */
async function reindex(deps: Deps, id: Uuid): Promise<void> {
  const { rows } = await deps.db.query<{ owner_id: string }>(
    `select owner_id from memories where id = $1`, [id],
  );
  const ownerId = rows[0]?.owner_id;
  if (!ownerId) return;
  const { indexMemory } = await import('../recall/index-chunks');
  await indexMemory(deps, { ownerId }, id).catch(() => {});
}

interface Saved {
  text: string | null;
  lane: Lane;
  error: string | null;
  /** `null` when there was no error; otherwise, whether a reprocess can help. */
  retryable?: boolean | null;
  detail: Record<string, unknown>;
}

/**
 * `normalized_at` is written no matter what: it means "this already ran", not
 * "this went well". Without that, a memory that fails stays in the pending queue
 * and the worker retries it until the end of time.
 *
 * And a failed run **does not touch what was already there**, neither the text
 * nor its provenance. The case that forces this: a photo transcribed months ago
 * by the vision lane, the credentials expire, and the reprocess pulls 30
 * characters of garbage through the document lane. Without this guard those 30
 * characters replace the good transcript — and "everything derived is
 * regenerable" turns from a safety net into a risk. Nobody reprocesses their
 * history if it can come out worse than before.
 *
 * Lane, detail and timestamp travel with the text: keeping the old transcript
 * but marking it as `lane = none` would lie about where it came from, and a
 * lane-filtered reprocess could no longer find it.
 */
async function save(deps: Deps, id: Uuid, s: Saved): Promise<void> {
  // The condition is evaluated against the row's PREVIOUS values, which is
  // exactly what is needed, and in a single statement so two workers cannot
  // clobber each other.
  const keep = `$4::text is not null and normalized_text is not null`;
  await deps.db.query(
    `update memories
        set normalized_text      = case when ${keep} then normalized_text      else $2       end,
            normalization_lane   = case when ${keep} then normalization_lane   else $3       end,
            normalization_detail = case when ${keep} then normalization_detail else $5::jsonb end,
            normalized_at        = case when ${keep} then normalized_at        else $6       end,
            normalization_error  = $4,
            normalization_retryable = $7,
            -- Status tells the truth: anything needing a human look lands in
            -- needs_review. A failed run used to leave the previous status, so a
            -- memory with not one letter extracted could read as normalized.
            status               = case when $4::text is null then 'normalized' else 'needs_review' end,
            updated_at           = now()
      where id = $1`,
    [id, s.text, s.lane, s.error, JSON.stringify(s.detail), deps.clock.now(), s.retryable ?? null],
  );
}
