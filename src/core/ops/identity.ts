import { randomBytes } from 'node:crypto';
import type { Uuid } from '../domain/types';
import type { Db } from '../ports';
import { err, ok, type Result } from '../result';

/**
 * No vowels and none of the characters people confuse by hand: no 0 or O, no
 * 1, I or L. The code gets dictated over the phone or copied from a terminal,
 * and a zero read as an O is a wasted call.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/** Fifteen minutes: enough to open the link, short enough not to linger. */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

export interface PairingCode {
  code: string;
  ownerId: Uuid;
  expiresAt: Date;
}

export interface Identity {
  channel: string;
  externalUserId: string;
  ownerId: Uuid;
  displayName: string | null;
}

const generate = (): string => {
  // Rejection sampling: the alphabet size does not divide 256, so taking the
  // modulus directly would bias the first letters. With 8 characters it makes no
  // practical difference, but a biased credential generator is not something to
  // leave written down for someone to copy where it does matter.
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]!);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join('');
};

/** Mints a single-use code that links a channel identity to an owner. */
export async function mintPairingCode(
  db: Db,
  ownerId: Uuid,
  now: Date,
  ttlMs = PAIRING_TTL_MS,
): Promise<Result<PairingCode>> {
  const owner = await db.query(`select 1 from owners where id = $1`, [ownerId]);
  if (owner.rowCount === 0) return err('not_found', `No existe el dueño ${ownerId}.`);

  const code = generate();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db.query(
    `insert into pairing_codes (code, owner_id, created_at, expires_at) values ($1, $2, $3, $4)`,
    [code, ownerId, now, expiresAt],
  );
  return ok({ code, ownerId, expiresAt });
}

/**
 * Redeems the code and links the identity.
 *
 * The update guarded on the code being unused is the part that matters: it is
 * what makes "single use" true even when two messages arrive at once. Without
 * that condition, checking and then writing leaves a window.
 */
export async function redeemPairingCode(
  db: Db,
  channel: string,
  externalUserId: string,
  code: string,
  now: Date,
  displayName: string | null = null,
): Promise<Result<Identity>> {
  const clean = code.trim().toUpperCase();
  if (!clean) return err('invalid', 'Falta el código.');

  return db.tx(async (tx) => {
    const claimed = await tx.query<{ owner_id: string }>(
      `update pairing_codes
          set used_at = $2, used_by = $3
        where code = $1 and used_at is null and expires_at > $2
        returning owner_id`,
      [clean, now, `${channel}:${externalUserId}`],
    );

    if (claimed.rowCount === 0) {
      // No distinction between "does not exist", "already used" and "expired", on
      // purpose: all three are fixed the same way — ask for another — and separating
      // them would tell a stranger whether a code exists.
      return err('not_found', 'Ese código no sirve. Pide uno nuevo con "dm pair".');
    }

    const ownerId = claimed.rows[0]!.owner_id;
    await tx.query(
      `insert into channel_identities (channel, external_user_id, owner_id, display_name, linked_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $5)
       on conflict (channel, external_user_id)
       do update set owner_id = excluded.owner_id,
                     display_name = coalesce(excluded.display_name, channel_identities.display_name),
                     last_seen_at = excluded.last_seen_at`,
      [channel, externalUserId, ownerId, displayName, now],
    );

    return ok({ channel, externalUserId, ownerId, displayName });
  });
}

/**
 * Who is writing. Null means unknown, and unknown means there is no actor — that
 * is, there is nothing this message can do.
 */
export async function identityOwner(
  db: Db,
  channel: string,
  externalUserId: string,
): Promise<Identity | null> {
  const { rows } = await db.query<{ owner_id: string; display_name: string | null }>(
    `select owner_id, display_name from channel_identities
      where channel = $1 and external_user_id = $2`,
    [channel, externalUserId],
  );
  if (rows.length === 0) return null;
  return {
    channel,
    externalUserId,
    ownerId: rows[0]!.owner_id,
    displayName: rows[0]!.display_name,
  };
}

/** Marks activity. Written separately to keep it off the read path. */
export async function touchIdentity(
  db: Db,
  channel: string,
  externalUserId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `update channel_identities set last_seen_at = $3
      where channel = $1 and external_user_id = $2`,
    [channel, externalUserId, now],
  );
}

export interface LinkedIdentity extends Identity {
  linkedAt: Date;
  lastSeenAt: Date | null;
}

/** For the health check, and to know whether anyone is connected. */
export async function listIdentities(db: Db, ownerId?: Uuid): Promise<LinkedIdentity[]> {
  const { rows } = await db.query<{
    channel: string; external_user_id: string; owner_id: string;
    display_name: string | null; linked_at: Date; last_seen_at: Date | null;
  }>(
    ownerId
      ? `select * from channel_identities where owner_id = $1 order by linked_at`
      : `select * from channel_identities order by linked_at`,
    ownerId ? [ownerId] : [],
  );
  return rows.map((r) => ({
    channel: r.channel,
    externalUserId: r.external_user_id,
    ownerId: r.owner_id,
    displayName: r.display_name,
    linkedAt: r.linked_at,
    lastSeenAt: r.last_seen_at,
  }));
}
