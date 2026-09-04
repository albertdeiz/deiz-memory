import type { Actor, Uuid } from '../domain/types';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { chunkText, contextualize } from './chunk';

export interface IndexOutcome {
  memoryId: Uuid;
  chunks: number;
}

/** How many chunks are embedded per call. A local model handles small batches better. */
const BATCH = 16;

/**
 * Chunks a memory and stores its vectors.
 *
 * **It still chunks with no embedder**, leaving the vector null. That looks like
 * a detail and is not: full-text retrieval runs over the chunks too, so with no
 * chunks there would be no degradation to full-text — there would be nothing.
 * Found because a test with the embedder off could not find what it had just
 * stored.
 *
 * Wholly replaceable: chunks and their embeddings derive from the blob, like the
 * text, so they are deleted and regenerated with no loss. Hence starting with a
 * delete — indexing twice does not duplicate.
 */
export async function indexMemory(
  deps: Deps,
  actor: Actor,
  memoryId: Uuid,
): Promise<Result<IndexOutcome>> {
  const { rows } = await deps.db.query<{
    id: string; title: string | null; note: string | null; normalized_text: string | null;
  }>(
    `select id, title, note, normalized_text from memories
      where id = $1 and owner_id = $2`,
    [memoryId, actor.ownerId],
  );
  if (rows.length === 0) return err('not_found', `No existe la memoria ${memoryId}.`);
  const m = rows[0]!;

  // Your words and the extracted text, in that order: if you only wrote a note,
  // that note still has to be findable by similarity.
  const source = [m.note, m.normalized_text].filter(Boolean).join('\n\n');
  const chunks = chunkText(source);

  await deps.db.query(`delete from memory_chunks where memory_id = $1`, [m.id]);
  if (chunks.length === 0) return ok({ memoryId: m.id, chunks: 0 });

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = deps.embedder
      ? await deps.embedder.embed(batch.map((t) => contextualize(t.content)))
      : null;

    for (const [j, t] of batch.entries()) {
      await deps.db.query(
        `insert into memory_chunks (memory_id, owner_id, seq, content, embedding)
         values ($1, $2, $3, $4, $5::vector)`,
        [m.id, actor.ownerId, t.seq, t.content, vectors ? JSON.stringify(vectors[j]) : null],
      );
    }
  }

  return ok({ memoryId: m.id, chunks: chunks.length });
}

/** How many memories are waiting to be indexed. For the health check and the chat. */
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

/** The ones still missing, to index in bulk. */
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
