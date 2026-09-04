import type { Actor, Lane, Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import type { Deps } from '../ports';
import { err, needsConfirmation, ok, type Result } from '../result';
import { resolveMemoryId } from './resolve';

export interface ReprocessInput {
  /** One specific memory. Excludes the other selectors. */
  ref?: string | null;
  /** The ones that failed or came out partial. The selector you will always use. */
  failed?: boolean;
  /** The ones that never went through a lane. */
  pending?: boolean;
  /** Everything with a file. For when a prompt improves. */
  all?: boolean;
  /** Narrows to one lane: "photos only". */
  lane?: Lane | null;
  limit?: number;
  confirm?: boolean;
}

export interface ReprocessResult {
  queued: number;
  ids: Uuid[];
  /** The same ones as prefixes, for display. `ids` promises uuids and must keep it. */
  shortIds: string[];
}

// Number('abc') is NaN, and NaN survives min/max unchanged: without this guard
// it ends up in a `limit $1` and the database returns a raw syntax error rather
// than a useful message.
const clampLimit = (n: number | undefined) =>
  !n || !Number.isFinite(n) ? 100 : Math.min(Math.max(Math.trunc(n), 1), 5_000);

/**
 * Everything derived is regenerable from the blob, and this is the door: improve
 * a lane's prompt and run the whole history through again.
 *
 * Not destructive — the original is untouched, which is why this is possible —
 * but it does cost: a hosted vision lane is paid per token. So in bulk it asks
 * for confirmation, like purge, for a completely different reason.
 */
export async function reprocess(
  deps: Deps,
  actor: Actor,
  input: ReprocessInput,
): Promise<Result<ReprocessResult>> {
  let ids: Uuid[];
  let labels = new Map<string, string | null>();

  if (input.ref) {
    const resolved = await resolveMemoryId(deps.db, actor, input.ref);
    if (!resolved.ok) return resolved;
    ids = [resolved.value];
  } else {
    const where: string[] = ['m.owner_id = $1', 'm.blob_sha256 is not null'];
    const params: unknown[] = [actor.ownerId];

    if (input.failed) where.push('m.normalization_error is not null');
    if (input.pending) where.push('m.normalized_at is null');
    if (input.lane) {
      params.push(input.lane);
      where.push(`m.normalization_lane = $${params.length}`);
    }

    // With no selector this would reprocess the entire library for no reason.
    // Demanding you name one is cheaper than explaining the bill afterwards.
    if (!input.failed && !input.pending && !input.lane && !input.all) {
      return err(
        'invalid',
        'Dime qué reprocesar: un id, o --failed, --pending, --lane <carril> o --all.',
      );
    }

    // Selectors combine with AND, and two of those combinations can never return
    // anything: pending has not run a lane yet, and failed already did. Answering
    // "nothing to reprocess" would be worse than an error — you would read it as
    // everything being fine and walk away.
    if (input.pending && input.lane) {
      return err('invalid', 'Lo pendiente todavía no tiene carril asignado: --pending y --lane se excluyen.');
    }
    if (input.pending && input.failed) {
      return err('invalid', 'Lo fallido ya corrió y lo pendiente no: --pending y --failed se excluyen.');
    }

    params.push(clampLimit(input.limit));
    // The names come along too: a confirmation that says "3 memories" leaves you
    // nothing to decide on. That is what the affected list is for, and purge
    // already uses it this way.
    const { rows } = await deps.db.query<{ id: string; label: string | null }>(
      `select m.id, coalesce(m.title, m.original_filename) as label
         from memories m
        where ${where.join(' and ')}
        order by m.captured_at desc
        limit $${params.length}`,
      params,
    );
    ids = rows.map((r) => r.id);
    labels = new Map(rows.map((r) => [r.id, r.label]));
  }

  if (ids.length === 0) return ok({ queued: 0, ids: [], shortIds: [] });

  if (ids.length > 1 && !input.confirm) {
    // Up to ten are named: more than that is a wall and stops informing.
    const shown = ids.slice(0, 10);
    const affects = shown.map((id) => ({
      kind: 'memory',
      id,
      label: labels.get(id) ?? shortId(id),
    }));
    if (ids.length > shown.length) {
      affects.push({ kind: 'more', id: 'resto', label: `…y ${ids.length - shown.length} más` });
    }
    return needsConfirmation(
      `Reprocesar ${ids.length} memorias vuelve a correr los carriles sobre cada original. ` +
        'No se pierde nada —el archivo no se toca— pero el carril de visión se paga por token.',
      affects,
    );
  }

  for (const id of ids) await deps.ingest.process(id);

  return ok({ queued: ids.length, ids, shortIds: ids.map(shortId) });
}
