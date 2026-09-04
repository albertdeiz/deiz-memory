import { randomBytes } from 'node:crypto';
import type { Uuid } from '../domain/types';
import type { Db } from '../ports';
import { err, ok, type Result } from '../result';

/**
 * Sin vocales y sin los caracteres que se confunden a mano: nada de 0/O ni
 * 1/I/L. El código se dicta por teléfono o se copia de una terminal, y un
 * "cero" leído como "o" es una llamada perdida.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/** Quince minutos: suficiente para abrir el link, corto para que no quede vivo. */
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
  // rejection sampling: 256 % 31 ≠ 0, así que tomar el módulo directo sesgaría
  // las primeras letras del alfabeto. Con 8 caracteres da igual en la práctica,
  // pero un generador de credenciales sesgado no es algo que uno quiera dejar
  // escrito para que alguien lo copie después a un lugar donde sí importe.
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

/** Acuña un código de un solo uso para vincular una identidad de canal a un dueño. */
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
 * Canjea el código y deja la identidad vinculada.
 *
 * El `update ... where used_at is null` es la parte que importa: es lo que hace
 * que "de un solo uso" sea cierto aunque dos mensajes lleguen a la vez. Sin esa
 * condición en el UPDATE, comprobar y después escribir deja una ventana.
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
      // No se distingue entre "no existe", "ya se usó" y "venció, a propósito:
      // los tres se arreglan igual —pide otro— y separarlos le diría a un
      // extraño si un código existe.
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
 * Quién es quien escribe. `null` significa desconocido, y desconocido significa
 * que no hay Actor — o sea que no hay nada que este mensaje pueda hacer.
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

/** Marca actividad. Se escribe aparte para no meterla en el camino de lectura. */
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

/** Para `dm doctor` y para saber si ya hay alguien conectado. */
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
