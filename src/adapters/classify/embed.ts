import type { Embedder } from '../../core/ports';
import { postJson, probe } from '../normalize/http';

export interface EmbedConfig {
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey: string | null;
  timeoutMs: number;
}

/**
 * `nomic-embed-text` en Ollama: 768 dimensiones, local, y bueno en español.
 *
 * Cambiar de modelo **obliga a reindexar**: la columna `vector(768)` del
 * esquema depende de esta elección, y un vector de otro tamaño no entra. Por
 * eso `dimensions` está acá y no escondido en el adapter.
 */
export const defaultEmbedConfig: EmbedConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'nomic-embed-text',
  dimensions: 768,
  apiKey: null,
  timeoutMs: 120_000,
};

interface EmbedResponse {
  data?: { embedding: number[] }[];
}

export function ollamaEmbedder(cfg: EmbedConfig = defaultEmbedConfig): Embedder {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  return {
    dimensions: cfg.dimensions,

    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await postJson<EmbedResponse>({
        service: 'embeddings',
        url: `${base}/embeddings`,
        headers,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify({ model: cfg.model, input: texts }),
      });

      const out = (res.data ?? []).map((d) => d.embedding);
      if (out.length !== texts.length) {
        // Guardar un vector desalineado con su trozo es peor que no guardarlo:
        // la búsqueda devolvería la cita equivocada, con total seguridad.
        throw new Error(`pedí ${texts.length} vectores y volvieron ${out.length}`);
      }
      for (const v of out) {
        if (v.length !== cfg.dimensions) {
          throw new Error(
            `el modelo devuelve vectores de ${v.length} y el esquema espera ${cfg.dimensions}. ` +
              'Cambiar de modelo obliga a reindexar.',
          );
        }
      }
      return out;
    },

    async available() {
      const state = await probe('embeddings', `${base}/models`, 5_000, headers);
      return state.ok ? { ok: true, detail: `${cfg.model} · ${cfg.dimensions}d` } : state;
    },
  };
}
