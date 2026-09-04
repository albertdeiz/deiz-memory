import Anthropic from '@anthropic-ai/sdk';
import type { Converter, ExtractInput } from '../../core/ports';
import { IMAGE_TYPES, TRANSCRIPTION_PROMPT, unsupportedImage } from './prompt';

/** Tope de request de la API: 32 MB, y base64 infla un tercio. */
const MAX_BYTES = 22 * 1024 * 1024;

export interface VisionConfig {
  model: string;
  /** Transcribing is perception, not reasoning: more thinking does not read paper better. */
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  apiKey?: string | undefined;
}

export const defaultVisionConfig: VisionConfig = {
  model: 'claude-opus-5',
  effort: 'low',
  maxTokens: 32_000,
};

/**
 * With no key the SDK does not throw on construction: it fails on the call, with
 * a long message about authentication methods. That would land verbatim inside
 * the stored error, which is what the person ends up reading.
 */
const NO_CREDENTIALS = 'Could not resolve authentication method';
const explain = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.includes(NO_CREDENTIALS)
    ? 'falta la API key de Anthropic (pon ANTHROPIC_API_KEY en .env)'
    : raw;
};

/**
 * The hosted visual lane: the highest-quality path, and the only one that takes
 * PDF entero sin rasterizarlo.
 *
 * PDFs go whole as a document block, which has no equivalent in the other
 * provider's chat format: that is why the compatible adapter has to rasterize
 * and this one does not.
 *
 * This is the expensive lane. It is only reached when the cheap one had nothing.
 */
export function claudeVisionConverter(cfg: VisionConfig = defaultVisionConfig): Converter {
  const client = new Anthropic(cfg.apiKey ? { apiKey: cfg.apiKey } : {});

  const block = (bytes: Buffer, mediaType: string): Anthropic.ContentBlockParam => {
    const data = bytes.toString('base64');
    if (mediaType === 'application/pdf') {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType as 'image/jpeg', data },
    };
  };

  return {
    async extract({ bytes, mediaType }: ExtractInput) {
      // HEIC — what an iPhone produces — lands here. Naming the format saves the
      // time spent wondering why a photo was not transcribed.
      // perfectamente legible.
      if (mediaType !== 'application/pdf' && !IMAGE_TYPES.includes(mediaType)) {
        throw unsupportedImage(mediaType);
      }
      if (bytes.length > MAX_BYTES) {
        throw new Error(
          `el archivo pesa ${Math.round(bytes.length / 1024 / 1024)} MB y el tope de la API es 32 MB con base64.`,
        );
      }

      try {
        // Streaming, because a 40-page scan produces a lot of text and a single
        // request no-streaming se muere de timeout antes de terminar.
        const stream = client.messages.stream({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          output_config: { effort: cfg.effort },
          messages: [{ role: 'user', content: [block(bytes, mediaType), { type: 'text', text: TRANSCRIPTION_PROMPT }] }],
        });
        const response = await stream.finalMessage();

        if (response.stop_reason === 'refusal') {
          throw new Error(
            `el modelo se negó a transcribir (${response.stop_details?.category ?? 'sin categoría'}).`,
          );
        }

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();

        // A token-limit cut leaves half a policy stored looking like a whole policy.
        // The text is kept — it is useful — but flagged, so it shows up in the review
        // `dm show` y la agarre `dm reprocess --failed`.
        const cut = response.stop_reason === 'max_tokens';
        return {
          text,
          ...(cut
            ? { incomplete: `la transcripción se cortó en ${cfg.maxTokens} tokens: está incompleta` }
            : {}),
          detail: {
            tool: 'claude-vision',
            model: response.model,
            effort: cfg.effort,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            truncated: cut,
          },
        };
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) {
          throw new Error('la API key de Anthropic no es válida (revisa ANTHROPIC_API_KEY).');
        }
        if (e instanceof Anthropic.RateLimitError) {
          throw new Error('la API está limitando el ritmo; reintenta con dm reprocess --failed.');
        }
        if (e instanceof Anthropic.APIError) {
          throw new Error(`la API respondió ${e.status}: ${e.message}`);
        }
        throw new Error(explain(e));
      }
    },

    async available() {
      try {
        // An authenticated GET, not an inference: it validates the key AND that the
        // model exists, without generating a token. The health check runs constantly —
        // including in tests — and a diagnostic that bills every time you ask how the
        // system is doing is an unpleasant surprise.
        await client.models.retrieve(cfg.model);
        return { ok: true, detail: `${cfg.model} · esfuerzo ${cfg.effort}` };
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) return { ok: false, detail: 'API key inválida' };
        if (e instanceof Anthropic.NotFoundError) return { ok: false, detail: `no existe el modelo ${cfg.model}` };
        return { ok: false, detail: explain(e) };
      }
    },
  };
}
