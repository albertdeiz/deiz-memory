import type { Actor, Uuid } from '../domain/types.js';
import { activeDomains } from '../ops/domains.js';
import type { Deps } from '../ports.js';
import { err, ok, type Result } from '../result.js';
import { buildPrompt, validate, type Classification } from './prompt.js';

/**
 * Debajo de esto la clasificación se guarda pero se marca para revisar (§3.4):
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
 * Clasifica una memoria: dominio, título y fecha del hecho.
 *
 * No pisa lo que puso la persona. Si escribiste un título o una fecha al
 * capturar, eso gana — el clasificador rellena lo que falta, no corrige lo que
 * decidiste. Es la misma línea que separa `note` de `normalized_text`: lo tuyo
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

  // Sin nada que leer no hay nada que clasificar, y adivinar sería inventar.
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

  const raw = await deps.classifier.classify({ system, user });
  const c = validate(raw, domains);
  if (!c) return err('invalid', 'El clasificador devolvió algo que no se pudo usar.');

  await save(deps, actor, m, c);

  return ok({
    id: m.id,
    domain: c.domain,
    title: c.title,
    occurredAt: c.occurredAt,
    confidence: c.confidence,
    tags: c.tags,
  });
}

async function save(deps: Deps, actor: Actor, m: Row, c: Classification): Promise<void> {
  const domainId = c.domain
    ? (await deps.db.query<{ id: string }>(
        `select id from domains where owner_id = $1 and slug = $2`,
        [actor.ownerId, c.domain],
      )).rows[0]?.id ?? null
    : null;

  // `coalesce(existente, nuevo)`: lo que la persona puso gana siempre. El
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
