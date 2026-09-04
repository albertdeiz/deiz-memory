/**
 * Ports are few on purpose. Only the ones that buy something exist: a fake blob
 * store for tests, a fixed clock for deterministic dates, and a seam where the
 * queue plugs in without capture() knowing.
 */
export interface BlobStore {
  put(key: string, bytes: Buffer, mediaType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** For the health check: confirms the bucket answers. */
  healthy(): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Db {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

/**
 * Where capture() hands off the heavy work.
 *
 * Two implementations: one enqueues and returns in milliseconds (the normal
 * path), the other runs the lanes inline (`--wait` and tests). capture() cannot
 * tell which it got, which was the entire point of the port.
 */
export interface Ingest {
  process(memoryId: string): Promise<void>;
}

/** What a converter was handed, and what is worth recording about the result. */
export interface ExtractInput {
  bytes: Buffer;
  mediaType: string;
  filename: string | null;
}

export interface Extraction {
  text: string;
  /** Model, pages, duration: whatever makes a later reprocess understandable. */
  detail?: Record<string, unknown>;
  /**
   * The lane returned text but knows it is incomplete — cut off by a token
   * limit, a truncated audio. Not a failure, since the text is useful, but not
   * a success either: it is stored and flagged for reprocessing.
   *
   * It exists because a partial transcript that reads as complete is exactly
   * the failure mode of never inventing anything.
   */
  incomplete?: string;
}

/**
 * A normalization lane. All three have the same shape — bytes to text — and
 * none knows about the others: the core's router is what picks.
 *
 * `available()` exists because all three can genuinely be missing: no service,
 * no converter. An absent lane has to show up in the health check as data, not
 * as an exception at midnight.
 */
export interface Converter {
  extract(input: ExtractInput): Promise<Extraction>;
  available(): Promise<{ ok: boolean; detail: string }>;
}

/** The three slots. `null` is a lane that is legitimately not configured. */
export interface Converters {
  document: Converter | null;
  vision: Converter | null;
  audio: Converter | null;
}

export const noConverters: Converters = { document: null, vision: null, audio: null };

/**
 * Whatever decides domain, title and date of the event.
 *
 * A port and not a concrete client for the same reason as the lanes: the model
 * is interchangeable and the core has no business knowing where it runs. `null`
 * is a legitimate state — the system works unclassified, categories just get
 * filled in by hand.
 */
export interface Classifier {
  /**
   * Asks for JSON and returns it parsed.
   *
   * The `schema` comes from the caller, which is why the adapter knows nothing
   * about classifications or facts: it only knows how to ask a model for shaped
   * JSON. While the schema lived in the adapter, the fact extractor received
   * the classifier's own response — domain, title, tags — no matter what it had
   * asked for.
   */
  classify(prompt: { system: string; user: string; schema: object }): Promise<unknown>;
  /**
   * Asks for prose and returns it as-is.
   *
   * Two methods rather than one because the output is treated differently:
   * classifying demands valid JSON validated against reality, while answering a
   * question is text, and what gets verified there is that it carries a
   * citation.
   */
  complete(prompt: { system: string; user: string }): Promise<string>;
  available(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Turns text into vectors.
 *
 * `dimensions` travels with the port because changing model changes the vector
 * size, and that forces a full reindex — not a configuration detail that can be
 * flipped without consequences.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  available(): Promise<{ ok: boolean; detail: string }>;
}

export interface Deps {
  db: Db;
  blobs: BlobStore;
  clock: Clock;
  ingest: Ingest;
  converters: Converters;
  classifier?: Classifier | null;
  embedder?: Embedder | null;
}
