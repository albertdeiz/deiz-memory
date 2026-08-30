import type { Actor, MemoryDetail, MemorySummary } from '../domain/types.js';
import type { Deps } from '../ports.js';
import { err, ok, type Result } from '../result.js';
import { resolveMemoryId } from './resolve.js';
import { MEMORY_COLUMNS, MEMORY_FROM, type MemoryRow, toDetail, toSummary } from './rows.js';

export interface ListInput {
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
}

export interface SearchInput extends ListInput {
  query: string;
}

const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? 20, 1), 200);
const clampOffset = (n: number | undefined) => Math.max(n ?? 0, 0);

export async function list(
  deps: Deps,
  actor: Actor,
  input: ListInput = {},
): Promise<Result<MemorySummary[]>> {
  const { rows } = await deps.db.query<MemoryRow>(
    `select ${MEMORY_COLUMNS} ${MEMORY_FROM}
      where m.owner_id = $1 and ($2 or not m.hidden)
      order by m.captured_at desc, m.id desc
      limit $3 offset $4`,
    [actor.ownerId, input.includeHidden ?? false, clampLimit(input.limit), clampOffset(input.offset)],
  );
  return ok(rows.map(toSummary));
}

/**
 * websearch_to_tsquery entiende comillas, OR y - para excluir, que es lo que la
 * gente ya escribe. La config es_unaccent ignora tildes y aplica stemming español.
 */
export async function search(
  deps: Deps,
  actor: Actor,
  input: SearchInput,
): Promise<Result<MemorySummary[]>> {
  const q = input.query?.trim();
  if (!q) return err('invalid', 'La búsqueda no puede ir vacía.');

  const { rows } = await deps.db.query<MemoryRow>(
    `select ${MEMORY_COLUMNS} ${MEMORY_FROM}
      where m.owner_id = $1
        and ($3 or not m.hidden)
        and m.search_tsv @@ websearch_to_tsquery('es_unaccent', $2)
      order by ts_rank(m.search_tsv, websearch_to_tsquery('es_unaccent', $2)) desc,
               m.captured_at desc
      limit $4 offset $5`,
    [actor.ownerId, q, input.includeHidden ?? false, clampLimit(input.limit), clampOffset(input.offset)],
  );
  return ok(rows.map(toSummary));
}

export async function show(deps: Deps, actor: Actor, ref: string): Promise<Result<MemoryDetail>> {
  const resolved = await resolveMemoryId(deps.db, actor, ref);
  if (!resolved.ok) return resolved;

  const { rows } = await deps.db.query<MemoryRow>(
    `select ${MEMORY_COLUMNS} ${MEMORY_FROM} where m.id = $1 and m.owner_id = $2`,
    [resolved.value, actor.ownerId],
  );
  if (rows.length === 0) return err('not_found', `No existe la memoria ${ref}.`);
  return ok(toDetail(rows[0]!));
}

export interface BlobPayload {
  bytes: Buffer;
  filename: string;
  mediaType: string;
  sha256: string;
}

export async function fetchBlob(deps: Deps, actor: Actor, ref: string): Promise<Result<BlobPayload>> {
  const detail = await show(deps, actor, ref);
  if (!detail.ok) return detail;

  const m = detail.value;
  if (!m.sha256) {
    return err('invalid', `La memoria ${m.shortId} es solo texto: no tiene archivo original.`);
  }

  const { rows } = await deps.db.query<{ storage_key: string; media_type: string }>(
    `select storage_key, media_type from blobs where sha256 = $1`,
    [m.sha256],
  );
  if (rows.length === 0) return err('not_found', `El blob ${m.sha256} no está registrado.`);

  const bytes = await deps.blobs.get(rows[0]!.storage_key);
  return ok({
    bytes,
    filename: m.originalFilename ?? `${m.shortId}.bin`,
    mediaType: rows[0]!.media_type,
    sha256: m.sha256,
  });
}
