import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { Attachment, Capabilities, Channel, Incoming, Reply, Turn } from '../../core/channel/types.js';

/**
 * Un canal en memoria. No es solo un doble de test: es el **segundo canal**.
 *
 * Y por eso declara `supportsButtons: false`. Si el único canal real tuviera
 * botones, la rama degradada de §7.1 no la ejercitaría nadie y sería una
 * intención escrita en un comentario. Con este, cada corrida de `dm chat` y
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
  /** Empuja un mensaje y devuelve lo que el bot respondió en ese turno. */
  send(input: { text?: string | null; attachment?: Attachment | null; action?: string | null; at?: Date }): Promise<Reply[]>;
  /** Como `send`, pero desde otra persona. Para probar aislamiento. */
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
    // El turno se cierra al volver: `reply` deja de servir después, igual que
    // en un canal de verdad. Es §2 sostenida por el tipo, y acá se comprueba.
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
 * Un adjunto desde el disco, para tests y para `dm chat --file`.
 *
 * Necesita el tamaño de verdad: el límite del canal se compara ANTES de bajar,
 * así que un adjunto que dice `sizeBytes: null` esquiva la comprobación entera
 * y la deja de adorno. Se hace `stat` al construirlo, no al leerlo.
 */
export const fileAttachment = async (path: string, sizeOverride?: number): Promise<Attachment> => ({
  filename: basename(path),
  declaredMediaType: null,
  sizeBytes: sizeOverride ?? (await stat(path)).size,
  fetch: () => readFile(path),
});

/** Un adjunto que se pasa del límite sin existir: prueba que no se baja nada. */
export const oversizedAttachment = (sizeBytes: number): Attachment => ({
  filename: 'enorme.pdf',
  declaredMediaType: 'application/pdf',
  sizeBytes,
  fetch: async () => {
    throw new Error('no se debería haber bajado: el tamaño se compara antes');
  },
});
