import type { Channel, Incoming, Turn } from '../../core/channel/types';
import type { Deps } from '../../core/ports';
import { identityOwner, touchIdentity } from '../../core/ops/identity';
import { classify } from '../../core/router/intent';
import { pair, route } from '../../core/router/route';
import { readSession } from '../../core/router/session';
import { present } from './present';

/**
 * The loop: a message arrives, who it is gets resolved, it is routed, it is
 *
 * answered. Everything interesting happened before here — this file only glues
 * the pieces. Its being boring is the sign the boundaries landed where they should.
 */

/** A stranger gets one line and then silence, so the bot is not an echo. */
const SILENCE_MS = 10 * 60 * 1000;

export interface ServeOptions {
  /** For the log. Message bodies are never logged. */
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
   * One promise chain per conversation.
   *
   * The platform delivers in order but the handler is async: without this, two
   * consecutive messages interleave and clobber the session row. Ten lines that
   * avoid a bug that is very expensive to reproduce later.
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
      // With no identity there is no actor, and with no actor no operation is possible.
      // Nor is it stored for later review: a chat platform's user id cannot be forged,
      // and filing what a stranger sends under your owner id would be worse than
      // discarding it.
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

    // Ids and verbs, never bodies and never filenames.
    say(`${msg.externalUserId} ${intent.verb}${res.ok ? '' : ` · ${res.kind}`}`);
  };

  return channel.listen(handle);
}

/**
 * The only thing a stranger can do: present a code.
 *
 * Both the command with the code and the bare code are accepted, because whoever
 * copies it from a terminal to a phone will paste it whole only half the time.
 */
function onlyPairingCode(msg: Incoming): string | null {
  const t = msg.text?.trim() ?? '';
  if (!t || msg.attachment) return null;
  const m = /^\/(?:start|empezar)\s+(\S+)$/i.exec(t);
  if (m) return m[1]!;
  return /^[0-9A-Za-z]{8}$/.test(t) ? t : null;
}
