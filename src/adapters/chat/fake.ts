import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { Attachment, Capabilities, Channel, Incoming, Reply, Turn } from '../../core/channel/types';

/**
 * Un canal en memoria. No es solo un doble de test: es el **segundo canal**.
 *
 * Which is why it declares no button support. If the only real channel had
 * buttons, nobody would exercise the degraded branch and it would be an
 * intention written in a comment. With this, every CLI chat run exercises it.
 * cada test la prueba gratis.
 */
export interface FakeChannelOptions {
  chatId?: string;
  externalUserId?: string;
  displayName?: string | null;
  capabilities?: Partial<Capabilities>;
}

export const FAKE_CAPS: Capabilities = {
  maxUploadBytes: 8 * 1024 * 1024,
  maxDownloadBytes: 8 * 1024 * 1024,
  supportsButtons: false,
  supportsRichFormatting: false,
  canInitiate: false,
};

export interface FakeChannel extends Channel {
  /** Pushes a message and returns what the bot replied in that turn. */
  send(input: { text?: string | null; attachment?: Attachment | null; action?: string | null; at?: Date }): Promise<Reply[]>;
  /** Like `send`, but from someone else. For testing isolation. */
  sendAs(externalUserId: string, input: { text?: string | null; at?: Date }): Promise<Reply[]>;
}

export function fakeChannel(opts: FakeChannelOptions = {}): FakeChannel {
  const caps: Capabilities = { ...FAKE_CAPS, ...opts.capabilities };
  const chatId = opts.chatId ?? 'chat-1';
  const defaultUser = opts.externalUserId ?? 'user-1';
  let handler: ((turn: Turn) => Promise<void>) | null = null;

  const deliver = async (msg: Incoming): Promise<Reply[]> => {
    if (!handler) throw new Error('el canal falso no está escuchando');
    const out: Reply[] = [];
    // The turn closes on return: `reply` stops working afterwards, exactly as in a
    // real channel. The no-initiating rule held up by the type, checked here.
    let open = true;
    const turn: Turn = {
      incoming: msg,
      caps,
      async reply(r) {
        if (!open) throw new Error('el turno ya se cerró: el bot no inicia conversación');
        out.push(r);
      },
    };
    try {
      await handler(turn);
    } finally {
      open = false;
    }
    return out;
  };

  return {
    id: 'fake',
    capabilities: caps,

    async listen(h) {
      handler = h;
      return { async stop() { handler = null; } };
    },

    async healthy() {
      return { ok: true, detail: 'canal en memoria' };
    },

    async send(input) {
      return deliver({
        conversation: { channel: 'fake', chatId },
        externalUserId: defaultUser,
        displayName: opts.displayName ?? null,
        receivedAt: input.at ?? new Date(),
        text: input.text ?? null,
        attachment: input.attachment ?? null,
        action: input.action ?? null,
      });
    },

    async sendAs(externalUserId, input) {
      return deliver({
        conversation: { channel: 'fake', chatId: `chat-${externalUserId}` },
        externalUserId,
        displayName: null,
        receivedAt: input.at ?? new Date(),
        text: input.text ?? null,
        attachment: null,
        action: null,
      });
    },
  };
}

/**
 * An attachment from disk, for tests and for the CLI chat's file flag.
 *
 * It needs the real size: the channel's cap is compared BEFORE downloading, so
 * an attachment claiming a null size skips the check entirely and leaves it
 * decorative. It stats on construction, not on read.
 */
export const fileAttachment = async (path: string, sizeOverride?: number): Promise<Attachment> => ({
  filename: basename(path),
  declaredMediaType: null,
  sizeBytes: sizeOverride ?? (await stat(path)).size,
  fetch: () => readFile(path),
});

/** An attachment over the cap that does not exist: proves nothing is downloaded. */
export const oversizedAttachment = (sizeBytes: number): Attachment => ({
  filename: 'enorme.pdf',
  declaredMediaType: 'application/pdf',
  sizeBytes,
  fetch: async () => {
    throw new Error('no se debería haber bajado: el tamaño se compara antes');
  },
});
