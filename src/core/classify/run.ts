import type { Actor, Uuid } from '../domain/types';
import { activeDomains } from '../ops/domains';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { buildPrompt, classifySchema, validate, type Classification } from './prompt';

/**
 * Below this the classification is stored but flagged for review: the system
 * el sistema duda, no bloquea, y deja la duda en la bandeja de F1.6.
 */
export const LOW_CONFIDENCE = 0.6;

export interface ClassifyOutcome {
  id: Uuid;
  domain: string | null;
  title: string;
  occurredAt: string | null;
  confidence: number;
  tags: string[];
}

interface Row {
  id: string;
  note: string | null;
  normalized_text: string | null;
  original_filename: string | null;
  captured_at: Date;
  occurred_at: Date | null;
  title: string | null;
}

/**
 * Classifies a memory: domain, title and date of the event.
 *
 * It does not overwrite what the person put there. A title or a date you set at
 * capture wins — the classifier fills gaps, it does not revise your decisions.
 * Same line that separates your note from the extracted text: yours is not
 * no se regenera.
 */
export async function classifyMemory(
  deps: Deps,
  actor: Actor,
  memoryId: Uuid,
): Promise<Result<ClassifyOutcome>> {
  if (!deps.classifier) {
    return err('invalid', 'No hay clasificador configurado (DM_CLASSIFY_URL).');
  }

  const { rows } = await deps.db.query<Row>(
    `select id, note, normalized_text, original_filename, captured_at, occurred_at, title
       from memories where id = $1 and owner_id = $2`,
    [memoryId, actor.ownerId],
  );
  if (rows.length === 0) return err('not_found', `No existe la memoria ${memoryId}.`);
  const m = rows[0]!;

  const domains = await activeDomains(deps.db, actor);
  if (domains.length === 0) {
    return err('invalid', 'No hay dominios activos contra los que clasificar.');
  }

  // With nothing to read there is nothing to classify, and guessing would be inventing.
  if (!m.note && !m.normalized_text && !m.original_filename) {
    return err('invalid', 'Esta memoria no tiene texto todavía: normalízala primero.');
  }

  const { system, user } = buildPrompt({
    domains,
    text: m.normalized_text,
    note: m.note,
    filename: m.original_filename,
    capturedAt: m.captured_at,
  });

  const raw = await deps.classifier.classify({ system, user, schema: classifySchema });
  const c = validate(raw, domains);
  if (!c) return err('invalid', 'El clasificador devolvió algo que no se pudo usar.');

  await save(deps, actor, m, c);

  // Reclassifying changes which extractors apply, so the facts have to be rebuilt.
  // Without this, moving a memory to another category by hand left the facts of
  // the old one: the full pipeline did both things and this command did only one —
  // the same kind of gap that left the classifier with nobody calling it.
  // 
  await reextract(deps, actor, m.id);

  return ok({
    id: m.id,
    domain: c.domain,
    title: c.title,
    occurredAt: c.occurredAt,
    confidence: c.confidence,
    tags: c.tags,
  });
}

/** Rebuilds the facts. Failing does not invalidate the stored classification. */
async function reextract(deps: Deps, actor: Actor, id: Uuid): Promise<void> {
  const { extractFacts } = await import('../facts/extract');
  await extractFacts(deps, actor, id).catch(() => {});
}

async function save(deps: Deps, actor: Actor, m: Row, c: Classification): Promise<void> {
  const domainId = c.domain
    ? (await deps.db.query<{ id: string }>(
        `select id from domains where owner_id = $1 and slug = $2`,
        [actor.ownerId, c.domain],
      )).rows[0]?.id ?? null
    : null;

  // Coalescing existing over new: what the person put always wins. The
  // clasificador rellena huecos, no corrige decisiones.
  await deps.db.query(
    `update memories
        set domain_id = $3,
            title = coalesce(title, $4),
            occurred_at = coalesce(occurred_at, $5::date),
            tags = $6,
            domain_confidence = $7::real,
            status = case when $7::real < $8::real then 'needs_review' else 'classified' end,
            normalization_error = case
              when $7::real < $8::real then coalesce(normalization_error,
                'la clasificación quedó con poca confianza: conviene revisarla')
              else normalization_error end,
            normalization_retryable = case
              when $7::real < $8::real then coalesce(normalization_retryable, false)
              else normalization_retryable end,
            updated_at = now()
      where id = $1 and owner_id = $2`,
    [m.id, actor.ownerId, domainId, c.title, c.occurredAt, c.tags, c.confidence, LOW_CONFIDENCE],
  );
}
