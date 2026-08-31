import type { Actor, MemoryDetail, MemorySummary } from '../domain/types.js';
import { extensionForMediaType, extensionOf } from '../media.js';
import type { Deps } from '../ports.js';
import { err, ok, type Result } from '../result.js';
import { resolveMemoryId } from './resolve.js';
import { MEMORY_COLUMNS, MEMORY_FROM, type MemoryRow, toDetail, toSummary } from './rows.js';

export interface ListInput {
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
  /** Id de dominio. `list` ordena entonces por fecha del HECHO, no de captura. */
  domainId?: string | null;
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
  // Dentro de un dominio se ordena por cuándo PASÓ, no por cuándo lo guardaste
  // (§3.3, y es el criterio de listo de F2). Fuera de un dominio manda la
  // captura: sin fecha del hecho inferida, ordenar por ella sería ordenar por
  // nulls.
  const porDominio = input.domainId != null;
  const { rows } = await deps.db.query<MemoryRow>(
    `select ${MEMORY_COLUMNS} ${MEMORY_FROM}
      where m.owner_id = $1 and ($2 or not m.hidden)
        and ($5::uuid is null or m.domain_id = $5)
      order by ${porDominio
        ? 'coalesce(m.occurred_at, m.captured_at) desc'
        : 'm.captured_at desc'}, m.id desc
      limit $3 offset $4`,
    [actor.ownerId, input.includeHidden ?? false, clampLimit(input.limit), clampOffset(input.offset),
     input.domainId ?? null],
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
  const mediaType = rows[0]!.media_type;

  // Telegram entrega las fotos SIN nombre de archivo, así que sin esto el
  // original volvía como `a1b2c3d4.bin` y ningún visor lo abría. El media type
  // se detectó por magic bytes al capturar, o sea que es mejor dato que
  // cualquier nombre — derivar la extensión de ahí es lo correcto, no un
  // parche.
  const name = m.originalFilename && extensionOf(m.originalFilename)
    ? m.originalFilename
    : `${m.shortId}.${extensionForMediaType(mediaType)}`;

  return ok({ bytes, filename: name, mediaType, sha256: m.sha256 });
}
