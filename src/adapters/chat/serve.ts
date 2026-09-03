import type { Channel, Incoming, Turn } from '../../core/channel/types.js';
import type { Deps } from '../../core/ports.js';
import { identityOwner, touchIdentity } from '../../core/ops/identity.js';
import { classify } from '../../core/router/intent.js';
import { pair, route } from '../../core/router/route.js';
import { readSession } from '../../core/router/session.js';
import { present } from './present.js';

/**
 * El bucle: llega un mensaje, se resuelve quién es, se enruta, se responde.
 *
 * Todo lo interesante ya pasó antes de acá — este archivo solo pega las piezas.
 * Que sea aburrido es la señal de que las fronteras quedaron donde debían.
 */

/** Un desconocido recibe una línea y después silencio, para no ser un eco. */
const SILENCE_MS = 10 * 60 * 1000;

export interface ServeOptions {
  /** Para el log. Nunca se loguean cuerpos de mensaje (§14). */
  onEvent?: (line: string) => void;
}

export async function serveChannel(
  channel: Channel,
  deps: Deps,
  opts: ServeOptions = {},
): Promise<{ stop(): Promise<void> }> {
  const say = opts.onEvent ?? (() => {});
  const shushed = new Map<string, number>();

  /**
   * Una cadena de promesas por conversación.
   *
   * `getUpdates` entrega en orden pero el handler es async: sin esto, dos
   * mensajes seguidos se interleavan y se pisan `chat_sessions`. Diez líneas
   * que evitan un bug que después cuesta mucho reproducir.
   */
  const queues = new Map<string, Promise<void>>();
  const serialize = (key: string, work: () => Promise<void>): Promise<void> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(key, next.finally(() => { if (queues.get(key) === next) queues.delete(key); }));
    return next;
  };

  const handle = async (turn: Turn): Promise<void> => {
    const key = `${turn.incoming.conversation.channel}:${turn.incoming.conversation.chatId}`;
    return serialize(key, () => handleOne(turn));
  };

  const handleOne = async (turn: Turn): Promise<void> => {
    const msg: Incoming = turn.incoming;
    const now = msg.receivedAt;
    const who = await identityOwner(deps.db, msg.conversation.channel, msg.externalUserId);

    if (!who) {
      // Sin identidad no hay Actor, y sin Actor no hay operación posible.
      // Tampoco se guarda para revisar después: el user id de un canal de chat
      // no es falsificable, y archivar lo que manda un extraño bajo tu owner_id
      // sería peor que descartarlo.
      const code = onlyPairingCode(msg);
      if (code) {
        const res = await pair(deps, msg.conversation, msg.externalUserId, code, now, msg.displayName);
        for (const r of present(res, turn.caps)) await turn.reply(r);
        say(res.ok ? `vinculado ${msg.externalUserId}` : `código rechazado de ${msg.externalUserId}`);
        return;
      }
      const until = shushed.get(msg.externalUserId) ?? 0;
      if (now.getTime() < until) return;
      shushed.set(msg.externalUserId, now.getTime() + SILENCE_MS);
      await turn.reply({ kind: 'text', body: 'No te conozco.' });
      say(`desconocido ${msg.externalUserId}`);
      return;
    }

    const actor = { ownerId: who.ownerId };
    const session = await readSession(deps.db, msg.conversation);
    const intent = classify(msg, session ? {
      ids: session.pending?.ids ?? [],
      hasConfirm: session.pending?.confirm !== undefined,
      hasSave: session.pending?.save !== undefined,
    } : null);

    const res = await route(deps, actor, {
      conv: msg.conversation,
      intent,
      caps: turn.caps,
      now,
      displayName: msg.displayName,
    });

    for (const r of present(res, turn.caps)) await turn.reply(r);
    await touchIdentity(deps.db, msg.conversation.channel, msg.externalUserId, now);

    // Ids y verbos, jamás cuerpos ni nombres de archivo (§14).
    say(`${msg.externalUserId} ${intent.verb}${res.ok ? '' : ` · ${res.kind}`}`);
  };

  return channel.listen(handle);
}

/**
 * Lo único que un desconocido puede hacer: presentar un código.
 *
 * Se acepta `/start CODIGO` y el código pelado, porque quien lo copia de una
 * terminal a un teléfono lo va a pegar solo la mitad de las veces.
 */
function onlyPairingCode(msg: Incoming): string | null {
  const t = msg.text?.trim() ?? '';
  if (!t || msg.attachment) return null;
  const m = /^\/(?:start|empezar)\s+(\S+)$/i.exec(t);
  if (m) return m[1]!;
  return /^[0-9A-Za-z]{8}$/.test(t) ? t : null;
}
