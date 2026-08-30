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
 * El punto donde capture() suelta el trabajo pesado. Dos implementaciones:
 * `queueIngest` encola en pg-boss y vuelve en milisegundos (lo normal), e
 * `inlineIngest` corre los carriles ahí mismo (`--wait` y los tests).
 * capture() no sabe cuál le tocó, que era todo el punto del puerto.
 */
export interface Ingest {
  process(memoryId: string): Promise<void>;
}

/** Qué se le pidió a un convertidor y qué habría que guardar. */
export interface ExtractInput {
  bytes: Buffer;
  mediaType: string;
  filename: string | null;
}

export interface Extraction {
  text: string;
  /** Modelo, páginas, duración: lo que haga falta para entender un reproceso. */
  detail?: Record<string, unknown>;
  /**
   * El carril devolvió texto, pero sabe que está incompleto (se cortó por
   * límite de tokens, el audio se truncó). No es un fallo —el texto sirve— pero
   * tampoco es un éxito: se guarda y queda marcado para reprocesar.
   *
   * Existe porque una transcripción parcial que se lee como completa es
   * exactamente el modo de falla de la regla dura 2.
   */
  incomplete?: string;
}

/**
 * Un carril de normalización (§8.1). Los tres tienen la misma forma —bytes a
 * texto— y ninguno sabe de los otros: el router del core es el que elige.
 *
 * `available()` existe porque los tres pueden faltar de verdad: sin uv no hay
 * markitdown, sin API key no hay visión, sin binario no hay whisper. Un carril
 * ausente tiene que salir en `dm doctor` como un dato, no como una excepción
 * a medianoche.
 */
export interface Converter {
  extract(input: ExtractInput): Promise<Extraction>;
  available(): Promise<{ ok: boolean; detail: string }>;
}

/** Las tres ranuras. `null` es un carril legítimamente no configurado. */
export interface Converters {
  document: Converter | null;
  vision: Converter | null;
  audio: Converter | null;
}

export const noConverters: Converters = { document: null, vision: null, audio: null };

export interface Deps {
  db: Db;
  blobs: BlobStore;
  clock: Clock;
  ingest: Ingest;
  converters: Converters;
}
