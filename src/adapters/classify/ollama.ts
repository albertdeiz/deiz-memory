import type { Classifier } from '../../core/ports.js';
import { postJson, probe } from '../normalize/http.js';
import { classifySchema } from '../../core/classify/prompt.js';

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
 * Se probó `qwen3:4b` primero y se pasó del timeout: gasta el presupuesto
 * entero pensando en voz alta antes de responder, y clasificar en ocho
 * categorías no necesita razonamiento en cadena. El de 3B responde en ~12 s en
 * CPU y acierta.
 *
 * Nota de despliegue: en Docker sobre macOS esto corre en CPU, sin Metal. En un
 * VPS Linux es lo mismo; si quieres que vuele en tu Mac, Ollama nativo usa la
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
 * Por defecto apunta a Ollama en el mismo compose, y esa elección es distinta
 * de la del OCR a propósito: clasificar es elegir entre ocho categorías y
 * escribir un título de cinco palabras, y para eso un modelo chico rinde bien.
 * En el carril de visión no, porque ahí los modelos chicos fallan justo en los
 * dígitos —un número de póliza, un RUT— y por eso ahí ganó el OCR clásico.
 *
 * Nada sale del host, no cuesta por documento, y §14 deja de exigir verificar
 * la retención de un tercero antes de mandarle una receta médica. Cambiar a
 * OpenAI o a una pasarela es cambiar `DM_CLASSIFY_URL`.
 */
export function ollamaClassifier(cfg: ClassifyConfig = defaultClassifyConfig): Classifier {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  return {
    async classify({ system, user }) {
      const res = await postJson<ChatResponse>({
        service: 'clasificador',
        url: `${base}/chat/completions`,
        headers,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify({
          model: cfg.model,
          // Clasificar no es creativo: dos corridas sobre el mismo documento
          // deberían dar lo mismo.
          temperature: 0,
          // Le pide al servidor JSON válido en vez de rezar. El que no lo
          // soporte lo ignora, y por eso igual se parsea a la defensiva abajo.
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'clasificacion', schema: classifySchema },
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
      // Se limpia el bloque <think> igual que al clasificar, pero no se busca
      // JSON: acá la respuesta ES el texto.
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
 * Saca el JSON de una respuesta que puede venir con adornos.
 *
 * Un modelo chico a veces envuelve la respuesta en ```json, antepone una frase,
 * o —los que razonan, como qwen3— deja un bloque <think> antes. Nada de eso es
 * motivo para descartar una clasificación que por dentro está bien.
 */
function parseLoose(raw: string): unknown {
  const sinPensar = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const sinCerca = sinPensar.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(sinCerca);
  } catch {
    // Último intento: el primer objeto balanceado que aparezca.
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
