import Anthropic from '@anthropic-ai/sdk';
import type { Converter, ExtractInput } from '../../core/ports.js';
import { IMAGE_TYPES, TRANSCRIPTION_PROMPT, unsupportedImage } from './prompt.js';

/** Tope de request de la API: 32 MB, y base64 infla un tercio. */
const MAX_BYTES = 22 * 1024 * 1024;

export interface VisionConfig {
  model: string;
  /** Transcribir es percepción, no razonamiento: pensar más no lee mejor un papel. */
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
 * Sin API key el SDK no lanza al construirse: falla recién al llamar, y con un
 * mensaje largo en inglés sobre métodos de autenticación. Eso terminaría tal
 * cual dentro de `normalization_error`, que es lo que la persona va a leer.
 */
const NO_CREDENTIALS = 'Could not resolve authentication method';
const explain = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.includes(NO_CREDENTIALS)
    ? 'falta la API key de Anthropic (pon ANTHROPIC_API_KEY en .env)'
    : raw;
};

/**
 * Carril B por Anthropic: el camino de mejor calidad, y el único que acepta un
 * PDF entero sin rasterizarlo.
 *
 * Los PDF van enteros como bloque `document`, que no tiene equivalente en el
 * formato de chat de OpenAI: por eso el adapter compatible (`vision-openai.ts`)
 * tiene que rasterizar y este no.
 *
 * Es el carril caro. Solo se llega acá cuando el carril A no tenía nada que dar.
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
      // heic —lo que sale de un iPhone— cae acá. Decirlo con el nombre del
      // formato ahorra el rato de mirar por qué "no se transcribió" una foto
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
        // Streaming porque un escaneo de 40 páginas produce mucho texto y una
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

        // Un corte por max_tokens deja media póliza guardada con cara de póliza
        // entera. Se conserva el texto —sirve— pero se marca, para que salga en
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
        // Un GET autenticado, no una inferencia: valida la key Y que el modelo
        // exista, sin generar un token. `dm doctor` se corre a cada rato —y en
        // los tests— y un diagnóstico que factura cada vez que preguntas cómo
        // está el sistema es una sorpresa desagradable.
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
