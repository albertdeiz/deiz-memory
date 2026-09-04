import type { Actor, Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { buildExtractPrompt, extractSchema, validateExtraction } from './prompt';
import { typesForDomain } from './registry';
import type { FactType, FactValue } from './types';

export interface ExtractOutcome {
  memoryId: Uuid;
  shortId: string;
  /** The types that produced a fact. Empty is normal and not a failure. */
  extracted: string[];
  /** Fields the model gave that the document did not back. */
  discarded: string[];
}

interface MemoryRow {
  id: string;
  owner_id: string;
  note: string | null;
  normalized_text: string | null;
  domain_slug: string | null;
}

/**
 * Extracts the hard data from a memory.
 *
 * Only the types that declare interest in its domain are tried, which is what
 * keeps a supermarket receipt away from the policy extractor. Even then the
 * model can say it does not apply: the domain filter cuts the cost, it does not
 * replace the judgement.
 *
 * Never throws. One type failing invalidates neither the others nor the memory.
 */
export async function extractFacts(
  deps: Deps,
  actor: Actor,
  memoryId: Uuid,
): Promise<Result<ExtractOutcome>> {
  if (!deps.classifier) return err('invalid', 'No hay modelo para extraer.');

  const { rows } = await deps.db.query<MemoryRow>(
    `select m.id, m.owner_id, m.note, m.normalized_text, d.slug as domain_slug
       from memories m left join domains d on d.id = m.domain_id
      where m.id = $1 and m.owner_id = $2`,
    [memoryId, actor.ownerId],
  );
  if (rows.length === 0) return err('not_found', `No existe la memoria ${memoryId}.`);
  const m = rows[0]!;

  const source = [m.note, m.normalized_text].filter(Boolean).join('\n\n');
  if (!source.trim()) {
    return ok({ memoryId: m.id, shortId: shortId(m.id), extracted: [], discarded: [] });
  }

  const types = await typesForDomain(deps.db, actor.ownerId, m.domain_slug);

  // Facts of a type that no longer applies are dropped.
  //
  // The registry declares "this type applies to documents in this category". If
  // the memory moved category, the type stopped applying to it by the registry's
  // own definition, and leaving the fact there would contradict what the
  // registry says. Nothing is lost: a fact derives from the blob like a chunk,
  // and re-extracting rebuilds it.
  await deps.db.query(
    `delete from facts where memory_id = $1 and owner_id = $2
       and ($3::uuid[] = '{}' or not (type_id = any($3::uuid[])))`,
    [m.id, actor.ownerId, types.map((t) => t.id)],
  );

  const extracted: string[] = [];
  const discarded: string[] = [];

  for (const type of types) {
    const { system, user } = buildExtractPrompt(type, { text: source, note: m.note });
    let raw: unknown;
    try {
      raw = await deps.classifier.classify({ system, user, schema: extractSchema(type) });
    } catch {
      continue; // One type failing does not take the others with it.
    }
    const parsed = validateExtraction(raw, type, source);
    if (!parsed) continue;

    await save(deps, actor, m.id, type, parsed.payload);
    extracted.push(type.slug);
    discarded.push(...parsed.discarded.map((f: string) => `${type.slug}.${f}`));
  }

  return ok({ memoryId: m.id, shortId: shortId(m.id), extracted, discarded });
}

const asDate = (v: FactValue | undefined): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

async function save(
  deps: Deps,
  actor: Actor,
  memoryId: string,
  type: FactType,
  payload: Record<string, FactValue>,
): Promise<void> {
  const identity = type.identityField ? payload[type.identityField] : undefined;
  const validFrom = type.validFromField ? asDate(payload[type.validFromField]) : null;
  const validUntil = type.validUntilField ? asDate(payload[type.validUntilField]) : null;

  const { rows } = await deps.db.query<{ id: string }>(
    `insert into facts (owner_id, memory_id, type_id, payload, identity, valid_from, valid_until)
     values ($1,$2,$3,$4::jsonb,$5,$6::date,$7::date)
     on conflict (memory_id, type_id) do update
       set payload = excluded.payload, identity = excluded.identity,
           valid_from = excluded.valid_from, valid_until = excluded.valid_until,
           extracted_at = now()
     returning id`,
    [actor.ownerId, memoryId, type.id, JSON.stringify(payload),
     identity === undefined ? null : String(identity), validFrom, validUntil],
  );

  if (type.kind === 'state') await supersede(deps, actor, type, rows[0]!.id);
}

/**
 * Marks what this fact replaces as superseded.
 *
 * **Only for `state` types, and only when the validity windows do not overlap.**
 *
 * A policy that starts when the other ends is a succession. Two live at once is
 * not: that is a conflict, shown in full rather than resolved silently. Hence
 * the `where` requiring the earlier one to have ended before this one begins.
 *
 * Never called for a `period` type: August's statement does not replace July's,
 * because July's is still the truth about July.
 */
async function supersede(
  deps: Deps,
  actor: Actor,
  type: FactType,
  nuevoId: string,
): Promise<void> {
  await deps.db.query(
    `update facts anterior
        set superseded_by = $3
       from facts nuevo
      where nuevo.id = $3
        and anterior.owner_id = $1 and anterior.type_id = $2
        and anterior.id <> nuevo.id
        and anterior.superseded_by is null
        and anterior.identity is not distinct from nuevo.identity
        and anterior.valid_until is not null
        and nuevo.valid_from is not null
        and anterior.valid_until <= nuevo.valid_from`,
    [actor.ownerId, type.id, nuevoId],
  );
}
