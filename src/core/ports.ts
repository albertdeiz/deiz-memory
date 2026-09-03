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

/**
 * Quien decide dominio, título y fecha del hecho.
 *
 * Un puerto y no un cliente concreto por el mismo motivo que los carriles: el
 * modelo es intercambiable y el core no tiene por qué saber si corre en tu
 * máquina o en la nube. `null` es un estado legítimo — el sistema funciona sin
 * clasificar, solo que las categorías se llenan a mano.
 */
export interface Classifier {
  /** Pide JSON y lo devuelve parseado. Para clasificar. */
  classify(prompt: { system: string; user: string }): Promise<unknown>;
  /**
   * Pide prosa y la devuelve tal cual.
   *
   * Son dos métodos y no uno porque la salida se trata distinto: clasificar
   * exige JSON válido y se valida contra la realidad; responder una pregunta es
   * texto, y lo que se verifica ahí es que traiga cita (regla dura 1).
   */
  complete(prompt: { system: string; user: string }): Promise<string>;
  available(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Convierte texto en vectores. Local por defecto (Ollama en el compose).
 *
 * `dimensions` viaja con el puerto porque cambiar de modelo cambia el tamaño
 * del vector, y eso obliga a reindexar todo — no es un detalle de configuración
 * que se pueda cambiar sin consecuencias.
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
