/**
 * The channel contract. The point is not sending and receiving: it is
 * **declaring capabilities**, so the core degrades on its own instead of
 * assuming one platform.
 *
 * If anything in the core reads these flags and takes one platform's buttons for
 * granted, the second channel becomes a rewrite dressed as an adapter.
 */
export interface Capabilities {
  /** What the bot can SEND. */
  maxUploadBytes: number;
  /**
   * What the bot can DOWNLOAD. On some platforms this is a hard cap with no way
   * around it from the bot's side — not a degradation, a wall. That is why the
   * two directions are separate fields: they do not match.
   */
  maxDownloadBytes: number;
  supportsButtons: boolean;
  supportsRichFormatting: boolean;
  /**
   * Whether the channel allows writing before being written to.
   *
   * Declared because the contract asks for it, and today **nobody reads it** —
   * on purpose. The bot never starts a conversation, so there is nothing to
   * consult. It is here so that whoever wants to use it has to delete this
   * comment first.
   */
  canInitiate: boolean;
}

export interface Conversation {
  channel: string;
  chatId: string;
}

export interface Attachment {
  filename: string | null;
  /** What the channel claims. Byte sniffing wins anyway: bytes beat names. */
  declaredMediaType: string | null;
  sizeBytes: number | null;
  /**
   * Lazy on purpose: the size is compared against the download cap first, and
   * only then are the bytes paid for. It is also what lets a test build an
   * incoming message with no network and no files.
   */
  fetch(): Promise<Buffer>;
}

export interface Incoming {
  conversation: Conversation;
  /** The identity: the channel's own user id, which cannot be forged. */
  externalUserId: string;
  displayName: string | null;
  receivedAt: Date;
  /** Bare text, or a photo's caption. */
  text: string | null;
  attachment: Attachment | null;
  /** Callback of a button already pressed, when the channel has them. */
  action: string | null;
}

export interface Option {
  label: string;
  /**
   * What travels in the button. The same verb a person could type — see the
   * action vocabulary — pointing at an id, which is what makes a button from an
   * old message still correct today.
   */
  action: string;
  /**
   * What to TYPE for this same action where the channel has no buttons.
   *
   * Absent means `action` itself is typable, which is the case for everything
   * that carries no target. It exists only for the numbered ones: the button
   * says `view:a3f2c1d0` and the person says `view:2`, because nobody types
   * eight hex characters on a phone. One verb, two ways of pointing — not two
   * vocabularies to keep in sync.
   */
  typed?: string;
  /**
   * Grouping hint: options sharing a `group` belong together.
   *
   * A hint and not an instruction, because not every channel has rows. One
   * places them side by side; a channel without buttons ignores it entirely and
   * still lists what to type. Nothing about degradation depends on this — hence
   * optional, and it never changes which actions are offered.
   */
  group?: number;
}

export type Reply =
  | { kind: 'text'; body: string; options?: Option[] }
  | { kind: 'file'; filename: string; mediaType: string; bytes: Buffer; caption?: string };

/**
 * A turn: a message arrives, it is answered, it closes.
 *
 * `reply()` stops working the moment the handler returns, and that is not
 * tidiness — it is "the bot never starts a conversation" made into a type. With
 * no loose `send()` on the port, the bot has no *way* to initiate even if
 * someone wanted to: the method does not exist. A rule the compiler holds up is
 * not forgotten in six months.
 *
 * What is allowed, and legitimate, is replying several times **within** the
 * turn: that is still answering someone who just wrote.
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
  /** For the health check, like the lanes. */
  healthy(): Promise<{ ok: boolean; detail: string }>;
}
