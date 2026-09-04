import type { Classifier } from '../../core/ports';
import { postJson, probe } from '../normalize/http';

export interface ClassifyConfig {
  /** Base compatible con OpenAI. Ollama en el compose: http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
}

/**
 * `qwen2.5:3b` y no un modelo razonador.
 *
 * A reasoning model was tried first and blew the timeout: it spends the whole
 * entero pensando en voz alta antes de responder, y clasificar en ocho
 * budget thinking out loud, and choosing among eight categories needs no chain
 * CPU y acierta.
 *
 * Deployment note: in Docker on macOS this runs on CPU. On a Linux VPS it is the
 * same; to make it fly on a Mac, point the URL at a native host install that can
 * GPU y basta apuntar `DM_CLASSIFY_URL` al host.
 */
export const defaultClassifyConfig: ClassifyConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b',
  apiKey: null,
  timeoutMs: 180_000,
};

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * El clasificador, contra cualquier API compatible con OpenAI.
 *
 * By default it points at the model server in the same compose, and that choice
 * differs from the OCR one on purpose: classifying is picking among eight
 * categories and writing a five-word title, which a small model does well.
 * Not so in the vision lane, where small models fail exactly on the digits — a
 * policy number, a tax id — which is why classical OCR won there.
 *
 * Nothing leaves the host, it costs nothing per document, and there is no
 * third party whose retention policy has to be verified before sending it a
 * OpenAI o a una pasarela es cambiar `DM_CLASSIFY_URL`.
 */
export function ollamaClassifier(cfg: ClassifyConfig = defaultClassifyConfig): Classifier {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  return {
    async classify({ system, user, schema }) {
      const res = await postJson<ChatResponse>({
        service: 'clasificador',
        url: `${base}/chat/completions`,
        headers,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify({
          model: cfg.model,
          // Classifying is not creative: two runs over the same document should give the
          // same result.
          temperature: 0,
          // Asks the server for valid JSON instead of praying. One that does not support
          // it ignores the field, which is why parsing below is still defensive.
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'salida', schema },
          },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      return parseLoose(res.choices?.[0]?.message?.content ?? '');
    },

    async complete({ system, user }) {
      const res = await postJson<ChatResponse>({
        service: 'clasificador',
        url: `${base}/chat/completions`,
        headers,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      // The thinking block is stripped as when classifying, but no JSON is looked
      // for: here the answer IS the text.
      return (res.choices?.[0]?.message?.content ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
    },

    async available() {
      const state = await probe('clasificador', `${base}/models`, 5_000, headers);
      return state.ok ? { ok: true, detail: `${cfg.model} @ ${base}` } : state;
    },
  };
}

/**
 * Pulls the JSON out of a response that may arrive decorated.
 *
 * Un modelo chico a veces envuelve la respuesta en ```json, antepone una frase,
 * or a reasoning model leaves a thinking block first. None of that is grounds
 * for discarding a classification that is fine inside.
 */
function parseLoose(raw: string): unknown {
  const sinPensar = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const sinCerca = sinPensar.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(sinCerca);
  } catch {
    // Last resort: the first balanced object that appears.
    const start = sinCerca.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < sinCerca.length; i++) {
      if (sinCerca[i] === '{') depth++;
      else if (sinCerca[i] === '}' && --depth === 0) {
        try { return JSON.parse(sinCerca.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }
}
