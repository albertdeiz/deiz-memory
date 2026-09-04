import { Bot, InputFile, type Context } from 'grammy';
import type {
  Attachment, Capabilities, Channel, Incoming, Option, Reply, Turn,
} from '../../../core/channel/types';

/**
 * Telegram. Transport and nothing else.
 *
 * This is the only file in the project that knows what a `chat_id` or a
 * `callback_query` is. Everything that decides anything — which verb a message
 * is, how a reply looks, who may speak — lives in the router and the presenter,
 * and does not change when a second channel arrives.
 *
 * Kept thin on purpose: it is the reason "it has no tests of its own" is an
 * honest statement rather than an excuse.
 */

export interface TelegramConfig {
  token: string;
  /**
   * API base. It can point at a self-hosted Bot API server, which is the only
   * way to get past the download cap.
   * 20 MB para bajar archivos.
   */
  apiRoot?: string | undefined;
  /** The same cap, declared. A self-hosted server raises it. */
  maxDownloadBytes?: number;
}

/**
 * This platform's numbers, with their source.
 *
 * The download one is the one that hurts: the API will not fetch more than
 * 20 MB and **there is no workaround on the bot's side**. Not a graceful
 * degradation but a wall, which is why the core compares before trying.
 */
export const telegramCapabilities = (maxDownloadBytes = 20 * 1024 * 1024): Capabilities => ({
  maxUploadBytes: 50 * 1024 * 1024,
  maxDownloadBytes,
  supportsButtons: true,
  supportsRichFormatting: true,
  // The platform would allow writing first. We do not, and the port exposes no
  // method to do it even if someone wanted to.
  canInitiate: true,
});

/** The platform splits long messages; better to cut them ourselves. */
const MAX_TEXT = 3800;

const chunk = (s: string): string[] => {
  if (s.length <= MAX_TEXT) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_TEXT) {
    // Cut on a line break when one is near: splitting a word in half reads as a
    // bug, and transcripts live down here.
    const cut = rest.lastIndexOf('\n', MAX_TEXT);
    const at = cut > MAX_TEXT * 0.6 ? cut : MAX_TEXT;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
};

/**
 * De un mensaje de Telegram a un adjunto nuestro.
 *
 * The platform delivers a photo two different ways, and the difference matters:
 * sent as a photo it arrives compressed and unnamed, sent as a document the
 * original arrives. The original preserves the file, but from an iPhone that is
 * a HEIC. Neither is forced: whatever arrives is stored, exactly as it arrived.
 *
 */
function attachmentOf(ctx: Context): Attachment | null {
  const m = ctx.message;
  if (!m) return null;

  const pick = (): { fileId: string; name: string | null; mime: string | null; size: number | null } | null => {
    if (m.document) {
      return {
        fileId: m.document.file_id,
        name: m.document.file_name ?? null,
        mime: m.document.mime_type ?? null,
        size: m.document.file_size ?? null,
      };
    }
    if (m.photo?.length) {
      // The last one is the highest resolution.
      const p = m.photo[m.photo.length - 1]!;
      return { fileId: p.file_id, name: null, mime: 'image/jpeg', size: p.file_size ?? null };
    }
    // A voice note comes free: it arrives as OGG/Opus with no name, and media
    // detection already recognises the signature by magic bytes.
    const media = m.voice ?? m.audio ?? m.video ?? m.video_note;
    if (media) {
      const name = 'file_name' in media && typeof media.file_name === 'string' ? media.file_name : null;
      const mime = 'mime_type' in media && typeof media.mime_type === 'string' ? media.mime_type : null;
      return { fileId: media.file_id, name, mime, size: media.file_size ?? null };
    }
    return null;
  };

  const f = pick();
  if (!f) return null;

  return {
    filename: f.name,
    declaredMediaType: f.mime,
    sizeBytes: f.size,
    // Lazy: the core compares the size before this is ever called.
    fetch: async () => {
      const file = await ctx.api.getFile(f.fileId);
      if (!file.file_path) throw new Error('Telegram no devolvió la ruta del archivo');
      const base = (ctx.api as unknown as { options?: { apiRoot?: string } }).options?.apiRoot
        ?? 'https://api.telegram.org';
      const res = await fetch(`${base}/file/bot${ctx.api.token}/${file.file_path}`);
      if (!res.ok) throw new Error(`Telegram respondió ${res.status} al bajar el archivo`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

export function telegramChannel(cfg: TelegramConfig): Channel {
  const caps = telegramCapabilities(cfg.maxDownloadBytes);
  const bot = new Bot(cfg.token, cfg.apiRoot ? { client: { apiRoot: cfg.apiRoot } } : undefined);

  const send = async (ctx: Context, r: Reply): Promise<void> => {
    if (r.kind === 'file') {
      await ctx.replyWithDocument(new InputFile(r.bytes, r.filename), { caption: r.caption });
      return;
    }
    const parts = chunk(r.body);
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      // Buttons go only on the last chunk: repeating them looks broken.
      const markup = last && r.options?.length
        ? { inline_keyboard: rows(r.options) }
        : undefined;
      await ctx.reply(part, markup ? { reply_markup: markup } : {});
    }
  };

/**
   * Lays the options out in rows, respecting their group.
   *
   * The platform stacks one row per button, and with two actions per result that
   * is eleven rows on a page of five: a wall to scroll. Options sharing a group
   * go side by side; those without one stay alone, as before.
   * como antes.
   */
  const rows = (options: readonly Option[]): { text: string; callback_data: string }[][] => {
    const out: { text: string; callback_data: string }[][] = [];
    let current: number | undefined;
    for (const o of options) {
      const btn = { text: o.label, callback_data: o.action };
      if (o.group !== undefined && o.group === current && out.length > 0) out[out.length - 1]!.push(btn);
      else out.push([btn]);
      current = o.group;
    }
    return out;
  };

  const toIncoming = (ctx: Context, action: string | null): Incoming | null => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    if (!from || chatId === undefined) return null;
    return {
      conversation: { channel: 'telegram', chatId: String(chatId) },
      externalUserId: String(from.id),
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null,
      receivedAt: new Date((ctx.message?.date ?? Math.floor(Date.now() / 1000)) * 1000),
      text: ctx.message?.text ?? ctx.message?.caption ?? null,
      attachment: attachmentOf(ctx),
      action,
    };
  };

  return {
    id: 'telegram',
    capabilities: caps,

    async listen(handle) {
      const run = async (ctx: Context, action: string | null) => {
        const incoming = toIncoming(ctx, action);
        if (!incoming) return;
        const turn: Turn = { incoming, caps, reply: (r) => send(ctx, r) };
        await handle(turn);
      };

      bot.on('message', (ctx) => run(ctx, null));
      bot.on('callback_query:data', async (ctx) => {
        // Without this the platform leaves the button spinning forever.
        await ctx.answerCallbackQuery().catch(() => {});
        await run(ctx, ctx.callbackQuery.data);
      });

      // Nunca el cuerpo del mensaje (§14): un error de red no justifica escribir
      // a medical prescription in a log.
      bot.catch((e) => console.error(`[telegram] ${e.message}`));

      // start() does not resolve while the bot runs, so it is not awaited.
      void bot.start({ drop_pending_updates: true });
      return { async stop() { await bot.stop(); } };
    },

    async healthy() {
      try {
        const me = await bot.api.getMe();
        return { ok: true, detail: `@${me.username}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
