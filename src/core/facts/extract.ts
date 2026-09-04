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
  /** Los tipos que produjeron un hecho. Vacío es normal y no es un fallo. */
  extracted: string[];
  /** Campos que el modelo dio y el documento no respaldaba. */
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
 * Extrae los datos duros de una memoria (§4).
 *
 * Se intenta solo con los tipos que declaran interés en su dominio, que es lo
 * que evita pasarle una boleta del supermercado al extractor de pólizas. Y aun
 * así el modelo puede decir que no aplica: el filtro por dominio recorta el
 * costo, no reemplaza el criterio.
 *
 * No lanza. Un tipo que falla no invalida a los otros ni a la memoria.
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

  const tipos = await typesForDomain(deps.db, actor.ownerId, m.domain_slug);

  // Los hechos de un tipo que ya no aplica se van.
  //
  // `fact_types.domain_slug` declara "este tipo aplica a documentos de esta
  // categoría". Si la memoria se movió de categoría, el tipo dejó de aplicarle
  // por definición del propio registro, y dejar el hecho ahí contradiría lo que
  // el registro dice. No se pierde nada: un hecho es derivado del blob como los
  // trozos (§3.6), y `dm facts extract` lo rehace.
  await deps.db.query(
    `delete from facts where memory_id = $1 and owner_id = $2
       and ($3::uuid[] = '{}' or not (type_id = any($3::uuid[])))`,
    [m.id, actor.ownerId, tipos.map((t) => t.id)],
  );

  const extracted: string[] = [];
  const discarded: string[] = [];

  for (const type of tipos) {
    const { system, user } = buildExtractPrompt(type, { text: source, note: m.note });
    let raw: unknown;
    try {
      raw = await deps.classifier.classify({ system, user, schema: extractSchema(type) });
    } catch {
      continue; // Un tipo que falla no se lleva a los demás.
    }
    const parsed = validateExtraction(raw, type, source);
    if (!parsed) continue;

    await save(deps, actor, m.id, type, parsed.payload);
    extracted.push(type.slug);
    discarded.push(...parsed.descartados.map((f) => `${type.slug}.${f}`));
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

  if (type.kind === 'estado') await supersede(deps, actor, type, rows[0]!.id);
}

/**
 * Marca como superado lo que este hecho reemplaza.
 *
 * **Solo en los tipos `estado`, y solo cuando las vigencias no se solapan.**
 *
 * Una póliza que empieza cuando termina la otra es una sucesión. Dos vigentes a
 * la vez no lo son: eso es un conflicto, y la regla dura 3 dice que se muestran
 * las dos y jamás se elige una en silencio. Por eso el `where` exige que la
 * anterior haya terminado antes de que esta empiece.
 *
 * En un tipo `periodo` no se llama nunca: la cartola de agosto no reemplaza a
 * la de julio, porque la de julio sigue siendo la verdad sobre julio.
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
