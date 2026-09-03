import type { Conversation } from '../channel/types.js';
import type { Uuid } from '../domain/types.js';
import type { Db } from '../ports.js';

/**
 * Lo que la conversación está esperando.
 *
 * Vive en la base y no dentro del payload del botón, y esa decisión es la que
 * hace posible degradar: con el estado acá, el botón "más" y la palabra "más"
 * valen los mismos tres bytes. Si el cursor viajara en el `callback_data`, un
 * canal sin botones no podría reproducirlo.
 */
export interface Pending {
  /** Ids de la última página, para que "ver 3" signifique el tercero de esos. */
  ids?: string[];
  /** Texto que se ofreció guardar tras una búsqueda vacía (§5). */
  save?: string;
  /**
   * La memoria cuyo detalle está en pantalla.
   *
   * Separada de `ids` porque no es un elemento de la lista: es *lo que estás
   * mirando*. El botón "mandarme el original" del detalle codificaba
   * `abrir:1` y por lo tanto te mandaba el archivo del PRIMERO de la lista,
   * no el del que abriste. Guardar la lista y el foco por separado es lo que
   * permite que `ver 3` siga funcionando después de haber abierto el 2.
   */
  viewing?: string;
  /**
   * Una confirmación en curso: qué operación repetir si dices que sí.
   *
   * Se guarda la operación y sus argumentos, no un id de "cosa pendiente":
   * así el `sí` reejecuta exactamente lo mismo con `confirm: true`, y no hay
   * un segundo camino que pueda divergir del primero.
   *
   * `askedAt` existe porque un "sí" que llega media hora tarde no se refiere a
   * lo que la persona cree.
   */
  confirm?: {
    label: string;
    op: 'crearDominio' | 'fusionar';
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

/** Diez minutos: pasado eso, un "sí" ya no se refiere a lo que la persona cree. */
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

/** Una confirmación vencida no vale. Se comprueba al usarla, no al guardarla. */
export const confirmIsFresh = (p: Pending | null, now: Date): boolean => {
  if (!p?.confirm) return false;
  return now.getTime() - Date.parse(p.confirm.askedAt) < CONFIRM_TTL_MS;
};

/**
 * Cuántas memorias tuyas están esperando que un carril las lea.
 *
 * No es un dato de cortesía: una búsqueda que responde "no lo tengo" mientras
 * un OCR todavía corre **está mintiendo**. Usa el índice parcial
 * `memories_pending_idx` que la 003 dejó justamente para esto.
 */
export async function pendingCount(db: Db, ownerId: Uuid): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from memories
      where owner_id = $1 and blob_sha256 is not null and normalized_at is null`,
    [ownerId],
  );
  return Number(rows[0]?.n ?? 0);
}
