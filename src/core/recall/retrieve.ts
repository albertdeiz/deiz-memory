import type { Actor, Uuid } from '../domain/types.js';
import { findDomain } from '../ops/domains.js';
import type { Deps } from '../ports.js';
import { err, ok, type Result } from '../result.js';

/**
 * Recuperación híbrida (§6).
 *
 * El error clásico que §6 nombra es meter todo a un vector store y esperar que
 * funcione. No funciona para "¿cuál es mi número de póliza?": un número no se
 * parece semánticamente a nada, y el full-text lo encuentra exacto.
 *
 * Así que se usan los dos y se fusionan. Y antes de los dos, **el filtro
 * estructurado**: dominio y ventana de fechas recortan el universo primero,
 * que es lo que de verdad baja el ruido.
 */
export interface RetrieveInput {
  query: string;
  /** Slug o nombre de un dominio, para acotar. */
  domain?: string | null;
  desde?: Date | null;
  hasta?: Date | null;
  limit?: number;
}

export interface Passage {
  memoryId: Uuid;
  shortId: string;
  title: string | null;
  occurredAt: Date | null;
  capturedAt: Date;
  domainLabel: string | null;
  /** El trozo concreto que respondió, no el documento entero. Es la cita. */
  content: string;
  seq: number;
  /** De dónde vino: útil para entender por qué apareció. */
  via: 'texto' | 'semejanza' | 'ambos';
  score: number;
}

/**
 * Una pregunta no se busca con AND.
 *
 * `websearch_to_tsquery` exige TODOS los términos, que es lo correcto cuando
 * escribes `/buscar poliza auto` — pediste las dos cosas. Pero al preguntar
 * "¿cuál es el deducible de mi seguro de auto?", el párrafo que responde dice
 * "deducible" y no dice "auto": exigir los dos lo descarta. Medido sobre una
 * póliza real: cero trozos con AND, ocho con la palabra sola.
 *
 * Así que acá se hace OR y se deja que el ranking ordene. El filtro estructurado
 * —dominio y fechas— ya recortó el universo, que es lo que evita que el OR traiga
 * medio corpus.
 */
const anyOf = (q: string): string =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(' | ') || q;

const clampLimit = (n: number | undefined) =>
  !n || !Number.isFinite(n) ? 8 : Math.min(Math.max(Math.trunc(n), 1), 30);

/**
 * Cuánto pesa cada camino al fusionar.
 *
 * El full-text pesa más porque cuando acierta, acierta exacto: un RUT, un
 * número de póliza, una patente. La semejanza es la que rescata las preguntas
 * escritas con otras palabras que las del documento.
 */
const W_FTS = 1.0;
const W_VEC = 0.85;

interface Row {
  memory_id: string;
  title: string | null;
  occurred_at: Date | null;
  captured_at: Date;
  domain_label: string | null;
  content: string;
  seq: number;
  score: number;
}

export async function retrieve(
  deps: Deps,
  actor: Actor,
  input: RetrieveInput,
): Promise<Result<Passage[]>> {
  const q = input.query.trim();
  if (!q) return err('invalid', 'Dime qué buscar.');
  const limit = clampLimit(input.limit);

  // 1 · El filtro estructurado, primero. Recortar antes de buscar es lo que
  //     §6 llama híbrido, y es lo que baja el ruido de verdad.
  let domainId: string | null = null;
  if (input.domain) {
    const d = await findDomain(deps.db, actor, input.domain);
    if (!d) return err('not_found', `No tengo una categoría "${input.domain}".`);
    domainId = d.id;
  }

  const filtro = `
    m.owner_id = $1 and not m.hidden
    and ($2::uuid is null or m.domain_id = $2)
    and ($3::timestamptz is null or coalesce(m.occurred_at, m.captured_at) >= $3)
    and ($4::timestamptz is null or coalesce(m.occurred_at, m.captured_at) <= $4)`;
  const base = [actor.ownerId, domainId, input.desde ?? null, input.hasta ?? null];

  // 2 · Full-text sobre los trozos: preciso para lo que se escribe igual.
  const fts = await deps.db.query<Row>(
    `select c.memory_id, m.title, m.occurred_at, m.captured_at, d.label as domain_label,
            c.content, c.seq,
            ts_rank(to_tsvector('es_unaccent', c.content),
                    to_tsquery('es_unaccent', $5)) as score
       from memory_chunks c
       join memories m on m.id = c.memory_id
       left join domains d on d.id = m.domain_id
      where ${filtro}
        and to_tsvector('es_unaccent', c.content) @@ to_tsquery('es_unaccent', $5)
      order by score desc limit $6`,
    [...base, anyOf(q), limit * 2],
  );

  // 3 · Semejanza, si hay con qué. Sin embedder el sistema sigue funcionando:
  //     degrada a full-text, que es lo que hacía antes de F3.
  let vec: { rows: Row[] } = { rows: [] };
  if (deps.embedder) {
    const [v] = await deps.embedder.embed([q]);
    if (v) {
      vec = await deps.db.query<Row>(
        `select c.memory_id, m.title, m.occurred_at, m.captured_at, d.label as domain_label,
                c.content, c.seq,
                1 - (c.embedding <=> $5::vector) as score
           from memory_chunks c
           join memories m on m.id = c.memory_id
           left join domains d on d.id = m.domain_id
          where ${filtro} and c.embedding is not null
          order by c.embedding <=> $5::vector limit $6`,
        [...base, JSON.stringify(v), limit * 2],
      );
    }
  }

  return ok(merge(fts.rows, vec.rows, limit));
}

/**
 * Fusiona los dos caminos.
 *
 * Se normaliza cada lista contra su propio máximo antes de sumar, porque
 * `ts_rank` y la similitud coseno viven en escalas distintas y sumarlas crudas
 * dejaría que una domine a la otra por accidente de unidades.
 *
 * Un trozo que aparece en las dos listas sube: que dos métodos independientes
 * coincidan es la mejor señal que hay acá.
 */
function merge(fts: Row[], vec: Row[], limit: number): Passage[] {
  const norm = (rows: Row[]) => {
    const max = Math.max(...rows.map((r) => r.score), 0);
    return max > 0 ? rows.map((r) => ({ r, s: r.score / max })) : [];
  };

  const acc = new Map<string, { row: Row; fts: number; vec: number }>();
  const key = (r: Row) => `${r.memory_id}:${r.seq}`;

  for (const { r, s } of norm(fts)) {
    acc.set(key(r), { row: r, fts: s, vec: 0 });
  }
  for (const { r, s } of norm(vec)) {
    const prev = acc.get(key(r));
    if (prev) prev.vec = s;
    else acc.set(key(r), { row: r, fts: 0, vec: s });
  }

  return [...acc.values()]
    .map(({ row, fts: f, vec: v }) => ({
      memoryId: row.memory_id,
      shortId: row.memory_id.replace(/-/g, '').slice(0, 8),
      title: row.title,
      occurredAt: row.occurred_at,
      capturedAt: row.captured_at,
      domainLabel: row.domain_label,
      content: row.content,
      seq: row.seq,
      via: (f > 0 && v > 0 ? 'ambos' : f > 0 ? 'texto' : 'semejanza') as Passage['via'],
      score: f * W_FTS + v * W_VEC,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
