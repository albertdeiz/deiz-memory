import type { Actor, Lane, MemorySummary } from '../domain/types';
import type { Db, Deps } from '../ports';
import { ok, type Result } from '../result';
import { MEMORY_COLUMNS, MEMORY_FROM, type MemoryRow, toSummary } from './rows';

/**
 * The review inbox.
 *
 * The principle: if the system is unsure, it stores anyway and leaves the doubt
 * in an inbox. The first half always worked — capture never blocks and the
 * problem is recorded — but the inbox did not exist, so reviewing meant opening
 * a SQL client. This is the other half.
 */
export interface ReviewItem extends MemorySummary {
  lane: Lane | null;
  error: string;
  /**
   * Whether a reprocess can help. Null is "unknown": rows that failed before the
   * system could tell the difference, resolved on their own the next time they
   * run.
   */
  retryable: boolean | null;
  /** What was stored anyway. Its being little is exactly what to look at. */
  chars: number;
}

export interface ReviewInput {
  limit?: number;
  offset?: number;
}

const clampLimit = (n: number | undefined) =>
  !n || !Number.isFinite(n) ? 20 : Math.min(Math.max(Math.trunc(n), 1), 200);

/**
 * What came out doubtful, newest first.
 *
 * Filtered by owner like every query in the system, and backed by a partial
 * index — partial because the normal state of this list is empty.
 * 
 */
export async function listReview(
  deps: Deps,
  actor: Actor,
  input: ReviewInput = {},
): Promise<Result<ReviewItem[]>> {
  const { rows } = await deps.db.query<
    MemoryRow & { normalization_retryable: boolean | null }
  >(
    `select ${MEMORY_COLUMNS}, m.normalization_retryable ${MEMORY_FROM}
      where m.owner_id = $1 and m.normalization_error is not null
      order by m.captured_at desc
      limit $2 offset $3`,
    [actor.ownerId, clampLimit(input.limit), Math.max(input.offset ?? 0, 0)],
  );

  return ok(
    rows.map((r) => ({
      ...toSummary(r),
      lane: r.normalization_lane as Lane | null,
      error: r.normalization_error ?? '',
      retryable: r.normalization_retryable,
      chars: r.normalized_text?.length ?? 0,
    })),
  );
}

export interface ReviewCounts {
  total: number;
  /** The ones a reprocess could fix. */
  retryable: number;
  /** The ones needing something else: convert the file, or change lane. */
  needMore: number;
}

/**
 * For the health check and the chat: the number, without fetching the rows.
 *
 * It takes a database handle and not the full dependency set because the health
 * check runs before one is assembled, and demanding one just to count would be
 * ceremonia.
 */
export async function countReview(db: Db, actor: Actor): Promise<ReviewCounts> {
  const { rows } = await db.query<{ total: string; si: string; no: string }>(
    `select count(*)::text total,
            count(*) filter (where normalization_retryable is true)::text si,
            count(*) filter (where normalization_retryable is false)::text no
       from memories
      where owner_id = $1 and normalization_error is not null`,
    [actor.ownerId],
  );
  const r = rows[0]!;
  return {
    total: Number(r.total),
    retryable: Number(r.si),
    needMore: Number(r.no),
  };
}
