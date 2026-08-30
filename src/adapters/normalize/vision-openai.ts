import type { Converter, ExtractInput } from '../../core/ports.js';
import type { RasterResult } from './documents.js';
import { postJson, probe } from './http.js';
import { IMAGE_TYPES, TRANSCRIPTION_PROMPT, unsupportedImage } from './prompt.js';

/** Rasterizar un PDF es trabajo del sidecar de documentos; acá solo se pide. */
export type Rasterizer = (bytes: Buffer) => Promise<RasterResult>;

export interface VisionHttpConfig {
  /** Base compatible con OpenAI. Ollama: http://ollama:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  maxTokens: number;
  timeoutMs: number;
}

export const defaultVisionHttpConfig: VisionHttpConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5vl:3b',
  apiKey: null,
  maxTokens: 8_000,
  timeoutMs: 600_000,
};

interface ChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const dataUrl = (mediaType: string, base64: string) => `data:${mediaType};base64,${base64}`;

/**
 * Carril B contra cualquier API compatible con OpenAI: Ollama, llama.cpp, vLLM,
 * LM Studio, la propia OpenAI, o una pasarela como LiteLLM apuntando a donde sea.
 *
 * Es el adapter que hace real lo de "el modelo es un servicio, no una decisión
 * de arquitectura". Cambiar de motor es cambiar `baseUrl` y `model`; no hay
 * código que tocar ni imagen que reconstruir.
 *
 * La diferencia con el adapter de Anthropic es una sola, y viene del formato:
 * **el chat de OpenAI no sabe recibir un PDF**, solo imágenes. Así que un PDF
 * escaneado se rasteriza primero, página por página, y se manda como varias
 * imágenes en un mismo mensaje. Esa es exactamente la dependencia de poppler
 * que el camino de Anthropic se ahorra — acá la paga el sidecar, que ya tiene
 * pypdfium cargado.
 */
export function openAiVisionConverter(
  cfg: VisionHttpConfig = defaultVisionHttpConfig,
  rasterize?: Rasterizer,
): Converter {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  return {
    async extract({ bytes, mediaType }: ExtractInput) {
      const images: { mediaType: string; base64: string }[] = [];
      let rasterNote: RasterResult | null = null;

      if (mediaType === 'application/pdf') {
        if (!rasterize) {
          throw new Error(
            'este backend no acepta PDF y no hay servicio de documentos para rasterizarlo. ' +
              'Levanta el sidecar de documentos, o usa el backend de Anthropic.',
          );
        }
        rasterNote = await rasterize(bytes);
        if (rasterNote.pages.length === 0) throw new Error('el PDF no tiene páginas que rasterizar');
        for (const p of rasterNote.pages) images.push({ mediaType: p.mediaType, base64: p.dataBase64 });
      } else if (IMAGE_TYPES.includes(mediaType)) {
        images.push({ mediaType, base64: bytes.toString('base64') });
      } else {
        throw unsupportedImage(mediaType);
      }

      const res = await postJson<ChatResponse>({
        service: 'visión',
        url: `${base}/chat/completions`,
        headers,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          // Determinismo: transcribir no es una tarea creativa, y un modelo que
          // improvisa sobre un número de póliza es peor que uno que no responde.
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                ...images.map((img) => ({
                  type: 'image_url',
                  image_url: { url: dataUrl(img.mediaType, img.base64) },
                })),
                { type: 'text', text: TRANSCRIPTION_PROMPT },
              ],
            },
          ],
        }),
      });

      const choice = res.choices?.[0];
      const text = (choice?.message?.content ?? '').trim();

      // Mismo criterio que en Anthropic: media transcripción con cara de
      // transcripción entera es el modo de falla de la regla dura 2.
      const cutByTokens = choice?.finish_reason === 'length';
      const cutByPages = rasterNote?.truncated === true;
      const incomplete = cutByTokens
        ? `la transcripción se cortó en ${cfg.maxTokens} tokens: está incompleta`
        : cutByPages
          ? `solo se transcribieron ${rasterNote!.pages.length} de ${rasterNote!.totalPages} páginas`
          : undefined;

      return {
        text,
        ...(incomplete ? { incomplete } : {}),
        detail: {
          tool: 'openai-compatible',
          model: res.model ?? cfg.model,
          endpoint: base,
          pages: images.length,
          ...(res.usage?.completion_tokens ? { outputTokens: res.usage.completion_tokens } : {}),
        },
      };
    },

    async available() {
      const state = await probe('visión', `${base}/models`, 5_000, headers);
      if (!state.ok) return state;
      return { ok: true, detail: `${cfg.model} @ ${base}` };
    },
  };
}
