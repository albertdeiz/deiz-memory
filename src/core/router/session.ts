import type { Conversation } from '../channel/types';
import type { Uuid } from '../domain/types';
import type { Db } from '../ports';

/**
 * What the conversation is waiting for.
 *
 * It lives in the database and not inside the button payload, and that decision
 * is what makes degradation possible: with the state here, the "more" button and
 * the typed word "more" are worth the same four bytes. If the cursor travelled
 * in the callback data, a channel without buttons could not reproduce it.
 */
export interface Pending {
  /** Ids of the last page, so "view 3" means the third of those. */
  ids?: string[];
  /** Text offered for saving after an empty search. */
  save?: string;
  /**
   * The memory whose detail is on screen.
   *
   * Separate from `ids` because it is not an element of the list: it is *what
   * you are looking at*. The detail's "send me the original" button used to
   * encode position 1, and therefore sent you the FIRST item's file rather than
   * the one you opened. Keeping the list and the focus apart is what lets
   * "view 3" still work after opening the second.
   */
  viewing?: string;
  /**
   * A confirmation in flight: which operation to repeat if you say yes.
   *
   * The operation and its arguments are stored, not an id of some "pending
   * thing": that way a yes re-runs exactly the same call with confirm set, and
   * there is no second path that can drift from the first.
   *
   * `askedAt` exists because a yes arriving half an hour late does not refer to
   * what the person thinks it does.
   */
  confirm?: {
    label: string;
    op: 'createDomain' | 'mergeDomains';
    args: Record<string, string>;
    askedAt: string;
  };
}

export interface ChatSession {
  ownerId: Uuid;
  lastQuery: string | null;
  lastOffset: number;
  pending: Pending | null;
}

/** Ten minutes: past that, a yes no longer refers to what the person thinks. */
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export async function readSession(db: Db, conv: Conversation): Promise<ChatSession | null> {
  const { rows } = await db.query<{
    owner_id: string; last_query: string | null; last_offset: number; pending: Pending | null;
  }>(
    `select owner_id, last_query, last_offset, pending from chat_sessions
      where channel = $1 and chat_id = $2`,
    [conv.channel, conv.chatId],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    ownerId: r.owner_id,
    lastQuery: r.last_query,
    lastOffset: Number(r.last_offset),
    pending: r.pending,
  };
}

export async function writeSession(
  db: Db,
  conv: Conversation,
  ownerId: Uuid,
  s: { lastQuery?: string | null; lastOffset?: number; pending?: Pending | null },
  now: Date,
): Promise<void> {
  await db.query(
    `insert into chat_sessions (channel, chat_id, owner_id, last_query, last_offset, pending, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (channel, chat_id) do update
       set owner_id = excluded.owner_id,
           last_query = excluded.last_query,
           last_offset = excluded.last_offset,
           pending = excluded.pending,
           updated_at = excluded.updated_at`,
    [
      conv.channel, conv.chatId, ownerId,
      s.lastQuery ?? null,
      s.lastOffset ?? 0,
      s.pending ? JSON.stringify(s.pending) : null,
      now,
    ],
  );
}

/** An expired confirmation does not count. Checked on use, not on write. */
export const confirmIsFresh = (p: Pending | null, now: Date): boolean => {
  if (!p?.confirm) return false;
  return now.getTime() - Date.parse(p.confirm.askedAt) < CONFIRM_TTL_MS;
};

/**
 * How many of your memories are waiting for a lane to read them.
 *
 * Not a courtesy figure: a search that answers "I do not have it" while an OCR
 * pass is still running **is lying**. Backed by a partial index that exists
 * exactly for this.
 */
export async function pendingCount(db: Db, ownerId: Uuid): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from memories
      where owner_id = $1 and blob_sha256 is not null and normalized_at is null`,
    [ownerId],
  );
  return Number(rows[0]?.n ?? 0);
}
