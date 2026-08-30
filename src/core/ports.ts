/**
 * Los puertos son pocos a propósito. Solo existen los que compran algo:
 * un blob store falso en memoria para tests, un reloj fijo para fechas
 * deterministas, y un punto donde F1 enchufe la cola sin tocar capture().
 */
export interface BlobStore {
  put(key: string, bytes: Buffer, mediaType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Para `dm doctor`: comprueba que el bucket responde. */
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
 * En F0 el procesamiento es trivial y corre inline. El puerto existe para que
 * F1 lo reemplace por una cola sin que capture() se entere.
 */
export interface Ingest {
  process(memoryId: string): Promise<void>;
}

export interface Deps {
  db: Db;
  blobs: BlobStore;
  clock: Clock;
  ingest: Ingest;
}
