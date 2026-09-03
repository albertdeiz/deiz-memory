import { Bot, InputFile, type Context } from 'grammy';
import type {
  Attachment, Capabilities, Channel, Incoming, Option, Reply, Turn,
} from '../../../core/channel/types.js';

/**
 * Telegram. Transporte y nada más.
 *
 * Este archivo es el único del proyecto que sabe qué es un `chat_id` o un
 * `callback_query`. Todo lo que decide algo —qué verbo es un mensaje, cómo se
 * ve una respuesta, quién puede hablar— vive en `core/router` y en
 * `chat/present.ts`, y no cambia cuando entre WhatsApp.
 *
 * Se mantiene delgado a propósito: es la razón por la que "no tiene tests
 * propios" es una afirmación honesta y no una excusa.
 */

export interface TelegramConfig {
  token: string;
  /**
   * Base de la API. Se puede apuntar a un servidor Bot API local
   * (`tdlib/telegram-bot-api`), que es la única forma de saltarse el techo de
   * 20 MB para bajar archivos.
   */
  apiRoot?: string | undefined;
  /** El mismo techo, declarado. Con servidor local sube a 2000 MB. */
  maxDownloadBytes?: number;
}

/**
 * Los números de Telegram, con su fuente.
 *
 * El de descarga es el que duele: `getFile` no baja más de 20 MB y **no hay
 * workaround del lado del bot**. No es una degradación elegante, es un muro, y
 * por eso el core lo compara antes de intentar nada.
 */
export const telegramCapabilities = (maxDownloadBytes = 20 * 1024 * 1024): Capabilities => ({
  maxUploadBytes: 50 * 1024 * 1024,
  maxDownloadBytes,
  supportsButtons: true,
  supportsRichFormatting: true,
  // Telegram sí permitiría escribir primero. §2 dice que no lo hacemos, y el
  // puerto no expone un método para hacerlo aunque se quisiera.
  canInitiate: true,
});

/** Telegram parte los mensajes largos; mejor cortar nosotros que que corte él. */
const MAX_TEXT = 3800;

const chunk = (s: string): string[] => {
  if (s.length <= MAX_TEXT) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_TEXT) {
    // Cortar en un salto de línea si hay uno cerca: partir una palabra por la
    // mitad se ve como un error, y acá abajo hay transcripciones.
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
 * Telegram entrega una foto de dos formas distintas y conviene entender la
 * diferencia: como `photo` viene comprimida y sin nombre, y como `document`
 * viene el original. Mandar el original preserva el archivo (§3.6) pero desde
 * un iPhone eso es un HEIC, que hoy el OCR no lee. No se fuerza ninguna de las
 * dos: se guarda lo que llegue, tal cual llegó.
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
      // El último es el de mayor resolución.
      const p = m.photo[m.photo.length - 1]!;
      return { fileId: p.file_id, name: null, mime: 'image/jpeg', size: p.file_size ?? null };
    }
    // Una nota de voz sale gratis: Telegram la manda OGG/Opus sin nombre, y
    // `detectMediaType()` ya reconoce la firma `OggS` por magic bytes.
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
    // Perezoso: el core compara el tamaño antes de que esto se llame.
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
      // Los botones van solo en el último trozo: repetirlos se ve roto.
      const markup = last && r.options?.length
        ? { inline_keyboard: rows(r.options) }
        : undefined;
      await ctx.reply(part, markup ? { reply_markup: markup } : {});
    }
  };

/**
   * Reparte las opciones en filas respetando su `group`.
   *
   * Telegram apila una fila por botón, y con dos acciones por resultado eso son
   * once filas en una página de cinco: un muro que hay que scrollear. Las que
   * comparten `group` van lado a lado; las que no traen ninguno siguen solas,
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
        // Sin esto Telegram deja el botón "cargando" para siempre.
        await ctx.answerCallbackQuery().catch(() => {});
        await run(ctx, ctx.callbackQuery.data);
      });

      // Nunca el cuerpo del mensaje (§14): un error de red no justifica escribir
      // una receta médica en un log.
      bot.catch((e) => console.error(`[telegram] ${e.message}`));

      // start() no resuelve mientras el bot corre, así que no se espera.
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
