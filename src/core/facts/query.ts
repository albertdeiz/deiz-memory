import type { Actor, Uuid } from '../domain/types.js';
import { shortId } from '../domain/types.js';
import type { Db } from '../ports.js';
import { listFactTypes } from './registry.js';
import type { Fact, FactField, FactType } from './types.js';

interface Row {
  id: string; memory_id: string; type_id: string; payload: Record<string, string | number>;
  identity: string | null; valid_from: Date | null; valid_until: Date | null;
  superseded_by: string | null; confidence: number;
  slug: string; label: string; kind: string; title: string | null;
}

const toFact = (r: Row): Fact => ({
  id: r.id,
  memoryId: r.memory_id,
  typeId: r.type_id,
  typeSlug: r.slug,
  typeLabel: r.label,
  kind: r.kind as Fact['kind'],
  payload: r.payload ?? {},
  identity: r.identity,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
  supersededBy: r.superseded_by,
  confidence: r.confidence,
  shortId: shortId(r.memory_id),
  memoryTitle: r.title,
});

const SELECT = `
  select f.id, f.memory_id, f.type_id, f.payload, f.identity, f.valid_from,
         f.valid_until, f.superseded_by, f.confidence,
         t.slug, t.label, t.kind, m.title
    from facts f
    join fact_types t on t.id = f.type_id
    join memories m on m.id = f.memory_id`;

export async function listFacts(
  db: Db,
  actor: Actor,
  opts: { includeSuperseded?: boolean } = {},
): Promise<Fact[]> {
  const { rows } = await db.query<Row>(
    `${SELECT}
      where f.owner_id = $1 and not m.hidden
        and ($2 or f.superseded_by is null)
      order by t.label, coalesce(f.valid_from, f.extracted_at::date) desc`,
    [actor.ownerId, opts.includeSuperseded ?? false],
  );
  return rows.map(toFact);
}

export async function factsForMemory(db: Db, actor: Actor, memoryId: Uuid): Promise<Fact[]> {
  const { rows } = await db.query<Row>(
    `${SELECT} where f.owner_id = $1 and f.memory_id = $2`,
    [actor.ownerId, memoryId],
  );
  return rows.map(toFact);
}

/** Un campo de un tipo, que es lo que una pregunta puede estar pidiendo. */
export interface FieldRef {
  type: FactType;
  field: FactField;
}

const sinTildes = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * La raíz aproximada de una palabra en español.
 *
 * Sin esto el match era por palabra exacta, y "cuánto **paga** mi tarjeta" no
 * calzaba con el alias `pagar`. Pedirle a quien define un tipo que enumere
 * `pagar, paga, pago, pagos` es pedirle que se acuerde de conjugar: el sistema
 * puede hacerlo solo.
 *
 * Se quita el plural y después la terminación verbal o la vocal final, dejando
 * al menos tres letras: `pagar`, `paga`, `pago` y `pagos` caen todas en `pag`.
 */
const stem = (w: string): string => {
  let x = sinTildes(w);
  if (x.length > 4 && x.endsWith('es')) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s')) x = x.slice(0, -1);
  if (x.length > 3 && x.endsWith('r')) x = x.slice(0, -1);
  if (x.length > 3 && /[aeiou]$/.test(x)) x = x.slice(0, -1);
  return x;
};

/**
 * Dos palabras se refieren a lo mismo.
 *
 * Por prefijo y no por igualdad, porque `vence` y `vencimiento` son la misma
 * pregunta y ninguna raíz razonable las junta. Tres letras de mínimo: con dos
 * empezarían a chocar palabras que no tienen nada que ver.
 */
const mismaIdea = (a: string, b: string): boolean => {
  const [x, y] = [stem(a), stem(b)];
  const corta = x.length <= y.length ? x : y;
  return corta.length >= 3 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * Qué campo está pidiendo esta pregunta, si es que pide alguno.
 *
 * **Sin llamar a un modelo.** Los `aliases` del registro son exactamente para
 * esto: si una palabra de la pregunta calza con uno, hay camino de hecho. Que
 * un modelo eligiera el campo metería una decisión no verificable justo en el
 * único camino del sistema que es exacto.
 *
 * Cuando hay más de un tipo con el mismo alias —`vence` sirve para una póliza y
 * para una tarjeta— se devuelven todos y decide quien pregunta, que puede haber
 * nombrado el tipo.
 */
export function matchFields(question: string, types: FactType[]): FieldRef[] {
  const palabras = new Set(
    sinTildes(question).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2),
  );
  if (palabras.size === 0) return [];

  const out: FieldRef[] = [];
  for (const type of types) {
    // Nombrar el tipo acota: "el deducible de mi auto" contra "de mi tarjeta".
    const nombrado = sinTildes(type.label).split(/\s+/).some((w) => w.length > 3 && palabras.has(w));
    for (const field of type.fields) {
      if (field.aliases.some((a) => [...palabras].some((p) => mismaIdea(p, a)))) {
        out.push({ type, field });
      }
    }
    if (nombrado) {
      // Un tipo nombrado gana sobre uno que solo comparte un alias.
      const suyos = out.filter((r) => r.type.id === type.id);
      if (suyos.length > 0) return suyos;
    }
  }
  return out;
}

export interface FactHit {
  ref: FieldRef;
  fact: Fact;
  value: string | number;
  /** Ya no vale: se dice ANTES del dato (regla dura 10). */
  expired: boolean;
  /** Reemplazado por uno posterior. También se dice antes. */
  superseded: boolean;
}

/**
 * Los hechos que responden esta pregunta.
 *
 * Devuelve **todos** los que aplican, no el mejor: si hay dos pólizas vigentes
 * con deducibles distintos, la regla dura 3 dice que se muestran las dos. Elegir
 * en silencio es el modo de falla que este camino existe para evitar.
 */
export async function askFacts(
  db: Db,
  actor: Actor,
  question: string,
  now: Date,
): Promise<FactHit[]> {
  const types = await listFactTypes(db, actor);
  const refs = matchFields(question, types);
  if (refs.length === 0) return [];

  // Lo superado entra igual: si es lo único que hay, la respuesta correcta no
  // es "no lo tengo" sino "lo que tengo está superado, y dice esto".
  const facts = await listFacts(db, actor, { includeSuperseded: true });
  const hoy = now.toISOString().slice(0, 10);

  const hits: FactHit[] = [];
  for (const ref of refs) {
    for (const fact of facts) {
      if (fact.typeId !== ref.type.id) continue;
      const value = fact.payload[ref.field.name];
      if (value === undefined) continue;
      const hasta = fact.validUntil?.toISOString().slice(0, 10) ?? null;
      hits.push({
        ref,
        fact,
        value,
        // En un `periodo` no existe "vencido": la cartola de julio no venció,
        // sigue siendo la verdad sobre julio.
        expired: ref.type.kind === 'estado' && hasta !== null && hasta < hoy,
        superseded: fact.supersededBy !== null,
      });
    }
  }

  // Vigente primero, y dentro de eso lo más reciente. Un `periodo` responde con
  // su último período salvo que la pregunta diga otro.
  return hits.sort((a, b) => {
    const vivo = Number(a.expired || a.superseded) - Number(b.expired || b.superseded);
    if (vivo !== 0) return vivo;
    const fa = a.fact.validFrom?.getTime() ?? 0;
    const fb = b.fact.validFrom?.getTime() ?? 0;
    return fb - fa;
  });
}
