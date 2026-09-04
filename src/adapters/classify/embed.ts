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
 * A local embedding model: 768 dimensions, on-host, and good in Spanish.
 *
 * Cambiar de modelo **obliga a reindexar**: la columna `vector(768)` del
 * schema depends on this choice, and a vector of another size does not fit. That
 * is why the dimension count travels with the port instead of hiding here.
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
        // Storing a vector misaligned with its chunk is worse than not storing it:
        // search would return the wrong citation, with complete confidence.
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
