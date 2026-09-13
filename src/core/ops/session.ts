import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Actor, Uuid } from '../domain/types';
import type { Db, Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { redeemPairingCode } from './identity';

/**
 * Web sessions (§15).
 *
 * The chat never needed any of this, and the difference is worth stating rather
 * than absorbing: Telegram's user id is unforgeable because Telegram asserts it,
 * while a cookie is asserted by this system. So three things appear that §10
 * never carried — a secret, an expiry, and a way to revoke — and each one is a
 * way to be wrong that the chat channel simply did not have.
 *
 * What does NOT change is where the owner comes from. A session resolves to an
 * `Actor` and every operation takes it from there; there is no route that reads
 * an owner from a parameter the client could send. Hard rule 9 stays a property
 * of the type system, not of anyone's memory.
 */

/** Long enough that guessing is not a strategy; short enough to fit a cookie. */
const TOKEN_BYTES = 32;

/** A month. Long enough not to be a nuisance on a local tool, short enough to end. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WebSession {
  id: Uuid;
  ownerId: Uuid;
  expiresAt: Date;
  /** Returned exactly once, when the session is created. Never stored. */
  token?: string;
}

export interface SessionSummary {
  id: Uuid;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
  userAgent: string | null;
}

/**
 * The token is stored hashed, like a password would be.
 *
 * The database is backed up (§14.3), so storing tokens in the clear would mean
 * every snapshot carried a set of working credentials — and a restore, or a
 * leaked archive, would hand them over. A hash costs nothing here because
 * nobody ever needs the original back.
 */
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Exchanges a pairing code for a session.
 *
 * Reuses §10 whole: the code is one of the ones that already exist, single-use
 * and fifteen minutes old at most, and redeeming it writes the `channel = 'web'`
 * row exactly as Telegram writes its own. A new channel is one more row, not a
 * new mechanism.
 */
export async function openSession(
  deps: Deps,
  code: string,
  meta: { userAgent?: string | null } = {},
): Promise<Result<WebSession>> {
  const now = deps.clock.now();
  const token = randomBytes(TOKEN_BYTES).toString('base64url');

  // The identity is keyed by the token's hash and not by a browser-supplied id:
  // there is nothing a browser could tell us that we should believe.
  const identity = await redeemPairingCode(deps.db, 'web', hash(token).slice(0, 32), code, now, 'web');
  if (!identity.ok) return identity;

  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const { rows } = await deps.db.query<{ id: Uuid }>(
    `insert into web_sessions (owner_id, token_hash, expires_at, user_agent, last_seen_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [identity.value.ownerId, hash(token), expiresAt, meta.userAgent ?? null, now],
  );

  return ok({ id: rows[0]!.id, ownerId: identity.value.ownerId, expiresAt, token });
}

interface SessionRow {
  id: Uuid;
  owner_id: Uuid;
  expires_at: Date;
}

/**
 * Resolves a token to an actor, or to nothing.
 *
 * Nothing is `null` and never an error with a reason: a caller that learns WHY a
 * token failed learns whether it existed, and that is the one thing an unknown
 * caller should not be told.
 */
export async function actorForToken(
  deps: Deps,
  token: string | null | undefined,
): Promise<{ actor: Actor; sessionId: Uuid } | null> {
  if (!token) return null;
  const now = deps.clock.now();

  const { rows } = await deps.db.query<SessionRow>(
    `select id, owner_id, expires_at from web_sessions
      where token_hash = $1 and revoked_at is null and expires_at > $2`,
    [hash(token), now],
  );
  const row = rows[0];
  if (!row) return null;

  // Best-effort and deliberately not awaited for correctness: a session that
  // works must not stop working because a bookkeeping write was slow.
  void deps.db.query(`update web_sessions set last_seen_at = $2 where id = $1`, [row.id, now])
    .catch(() => {});

  return { actor: { ownerId: row.owner_id }, sessionId: row.id };
}

/** Constant-time compare, for the few places a token is compared to another. */
export const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(hash(a));
  const y = Buffer.from(hash(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function listSessions(deps: Deps, actor: Actor): Promise<Result<SessionSummary[]>> {
  const { rows } = await deps.db.query<{
    id: Uuid; created_at: Date; expires_at: Date; last_seen_at: Date | null; user_agent: string | null;
  }>(
    `select id, created_at, expires_at, last_seen_at, user_agent
       from web_sessions
      where owner_id = $1 and revoked_at is null and expires_at > now()
      order by created_at desc`,
    [actor.ownerId],
  );
  return ok(rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
    userAgent: r.user_agent,
  })));
}

/** Revoking is a timestamp, not a delete: knowing a session was cut is the point. */
export async function revokeSession(
  deps: Deps,
  actor: Actor,
  sessionId: Uuid,
): Promise<Result<{ id: Uuid }>> {
  const { rowCount } = await deps.db.query(
    `update web_sessions set revoked_at = now()
      where id = $1 and owner_id = $2 and revoked_at is null`,
    [sessionId, actor.ownerId],
  );
  if (rowCount === 0) return err('not_found', 'Esa sesión no existe o ya estaba revocada.');
  return ok({ id: sessionId });
}

/** Cuts every session of this owner, which is what "I lost my laptop" needs. */
export async function revokeAllSessions(deps: Deps, actor: Actor): Promise<Result<{ revoked: number }>> {
  const { rowCount } = await deps.db.query(
    `update web_sessions set revoked_at = now()
      where owner_id = $1 and revoked_at is null`,
    [actor.ownerId],
  );
  return ok({ revoked: rowCount });
}

/** For tests and for anyone who wants the hash without importing crypto twice. */
export const tokenHash = hash;

export type { Db };
