import type { Actor, Uuid } from '../domain/types.js';
import type { Deps } from '../ports.js';
import { err, ok, type Result } from '../result.js';
import { chunkText, contextualize } from './chunk.js';

export interface IndexOutcome {
  memoryId: Uuid;
  chunks: number;
}

/** Cuántos trozos se embeben por llamada. Ollama aguanta lotes chicos mejor. */
const BATCH = 16;

/**
 * Trocea una memoria y guarda sus vectores.
 *
 * Es reemplazable entero: los trozos y sus embeddings son derivados del blob,
 * igual que el texto, así que se borran y se regeneran sin pérdida. Por eso
 * empieza borrando — reindexar dos veces no duplica.
 */
export async function indexMemory(
  deps: Deps,
  actor: Actor,
  memoryId: Uuid,
): Promise<Result<IndexOutcome>> {
  if (!deps.embedder) return err('invalid', 'No hay modelo de embeddings configurado.');

  const { rows } = await deps.db.query<{
    id: string; title: string | null; note: string | null; normalized_text: string | null;
  }>(
    `select id, title, note, normalized_text from memories
      where id = $1 and owner_id = $2`,
    [memoryId, actor.ownerId],
  );
  if (rows.length === 0) return err('not_found', `No existe la memoria ${memoryId}.`);
  const m = rows[0]!;

  // Se indexa lo tuyo y lo extraído, en ese orden: si solo escribiste una nota,
  // esa nota igual tiene que ser encontrable por semejanza.
  const fuente = [m.note, m.normalized_text].filter(Boolean).join('\n\n');
  const trozos = chunkText(fuente);

  await deps.db.query(`delete from memory_chunks where memory_id = $1`, [m.id]);
  if (trozos.length === 0) return ok({ memoryId: m.id, chunks: 0 });

  for (let i = 0; i < trozos.length; i += BATCH) {
    const lote = trozos.slice(i, i + BATCH);
    const vectores = await deps.embedder.embed(
      lote.map((t) => contextualize(t.content)),
    );

    for (const [j, t] of lote.entries()) {
      await deps.db.query(
        `insert into memory_chunks (memory_id, owner_id, seq, content, embedding)
         values ($1, $2, $3, $4, $5::vector)`,
        [m.id, actor.ownerId, t.seq, t.content, JSON.stringify(vectores[j])],
      );
    }
  }

  return ok({ memoryId: m.id, chunks: trozos.length });
}

/** Cuántas memorias esperan ser indexadas. Para `dm doctor` y el chat. */
export async function pendingIndex(deps: Deps, actor: Actor): Promise<number> {
  const { rows } = await deps.db.query<{ n: string }>(
    `select count(*)::text n from memories m
      where m.owner_id = $1 and not m.hidden
        and (m.normalized_text is not null or m.note is not null)
        and not exists (select 1 from memory_chunks c where c.memory_id = m.id)`,
    [actor.ownerId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Las que faltan, para indexarlas en lote. */
export async function unindexed(deps: Deps, actor: Actor, limit: number): Promise<Uuid[]> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select m.id from memories m
      where m.owner_id = $1 and not m.hidden
        and (m.normalized_text is not null or m.note is not null)
        and not exists (select 1 from memory_chunks c where c.memory_id = m.id)
      order by m.captured_at desc limit $2`,
    [actor.ownerId, limit],
  );
  return rows.map((r) => r.id);
}
