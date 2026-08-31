/**
 * El contrato de §7.1. Lo importante no es enviar y recibir: es **declarar
 * capacidades**, para que el core degrade solo en vez de asumir un canal.
 *
 * Si algo del core lee estas banderas y da por hecho que existen los botones de
 * Telegram, el segundo canal es un rewrite disfrazado de adapter.
 */
export interface Capabilities {
  /** Lo que el bot puede MANDAR. Telegram: 50 MB para documentos. */
  maxUploadBytes: number;
  /**
   * Lo que el bot puede BAJAR. En Telegram son 20 MB y no hay forma de
   * esquivarlo desde el lado del bot — no es una degradación, es un muro. Por
   * eso las dos direcciones son campos distintos: no coinciden.
   */
  maxDownloadBytes: number;
  supportsButtons: boolean;
  supportsRichFormatting: boolean;
  /**
   * Si el canal deja escribir sin que te hablen primero.
   *
   * Se declara porque §7.1 lo pide, y hoy **nadie lo lee** — a propósito. §2
   * dice que el bot nunca inicia conversación, así que no hay nada que
   * consultar. Está acá para que el día que alguien quiera usarlo tenga que
   * borrar este comentario primero.
   */
  canInitiate: boolean;
}

export interface Conversation {
  channel: string;
  chatId: string;
}

export interface Attachment {
  filename: string | null;
  /** Lo que dice el canal. `detectMediaType()` manda igual: los bytes ganan. */
  declaredMediaType: string | null;
  sizeBytes: number | null;
  /**
   * Perezoso a propósito: primero se compara contra `maxDownloadBytes` y recién
   * después se pagan los bytes. También es lo que permite armar un `Incoming`
   * en un test sin red ni archivos.
   */
  fetch(): Promise<Buffer>;
}

export interface Incoming {
  conversation: Conversation;
  /** La identidad, según §10: el user id del canal, que no es falsificable. */
  externalUserId: string;
  displayName: string | null;
  receivedAt: Date;
  /** Texto suelto, o el pie de una foto. */
  text: string | null;
  attachment: Attachment | null;
  /** Callback de un botón ya presionado, si el canal los tiene. */
  action: string | null;
}

export interface Option {
  label: string;
  /** La MISMA cadena que la persona podría escribir. Ver `router/actions.ts`. */
  action: string;
}

export type Reply =
  | { kind: 'text'; body: string; options?: Option[] }
  | { kind: 'file'; filename: string; mediaType: string; bytes: Buffer; caption?: string };

/**
 * Un turno: llega un mensaje, se responde, se cierra.
 *
 * `reply()` deja de servir en cuanto el handler retorna, y eso no es prolijidad
 * — es §2 hecha tipo. Al no haber un `send()` suelto en el puerto, el bot no
 * tiene *cómo* iniciar conversación aunque alguien quiera: no existe el método.
 * Una regla que sostiene el compilador no se olvida en seis meses.
 *
 * Lo que sí se puede, y es legítimo, es responder varias veces **dentro** del
 * turno: eso sigue siendo contestarle a alguien que acaba de escribir.
 */
export interface Turn {
  readonly incoming: Incoming;
  readonly caps: Capabilities;
  reply(r: Reply): Promise<void>;
}

export interface Channel {
  readonly id: string;
  readonly capabilities: Capabilities;
  listen(handle: (turn: Turn) => Promise<void>): Promise<{ stop(): Promise<void> }>;
  /** Para `dm doctor`, igual que los carriles. */
  healthy(): Promise<{ ok: boolean; detail: string }>;
}
