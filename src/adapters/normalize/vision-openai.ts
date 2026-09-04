import type { Converter, ExtractInput } from '../../core/ports';
import type { RasterResult } from './documents';
import { postJson, probe } from './http';
import { IMAGE_TYPES, TRANSCRIPTION_PROMPT, unsupportedImage } from './prompt';

/** Rasterizing a PDF is the document service's job; here it is only requested. */
export type Rasterizer = (bytes: Buffer) => Promise<RasterResult>;

/** Converts an image the lane rejects into one it accepts. */
export type Transcoder = (bytes: Buffer, filename: string | null) => Promise<{ mediaType: string; bytes: Buffer }>;

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
 * a local server, the vendor itself, or a gateway pointing anywhere.
 *
 * This is the adapter that makes "the model is a service, not an architectural
 * de arquitectura". Cambiar de motor es cambiar `baseUrl` y `model`; no hay
 * code to touch and no image to rebuild.
 *
 * There is exactly one difference from the other provider's adapter, and it comes
 * from the format: **this chat API cannot take a PDF**, only images. So a scanned
 * PDF is rasterized first, page by page, and sent as several images in one
 * message. That is exactly the rasterizing dependency the other path avoids —
 * here the document service pays it, since it already has the library loaded.
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
          // Determinism: transcribing is not a creative task, and a model that improvises
          // on a policy number is worse than one that does not answer.
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

      // Same criterion as the other provider: half a transcript looking like a whole
      // one is the failure mode of never inventing anything.
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
