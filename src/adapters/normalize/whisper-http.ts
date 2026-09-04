import { extensionForMediaType, extensionOf } from '../../core/media';
import type { Converter, ExtractInput } from '../../core/ports';
import { formWithFile, postJson, probe } from './http';

export interface SpeechConfig {
  /** Base de una API compatible con OpenAI: termina antes de /audio/transcriptions. */
  baseUrl: string;
  model: string;
  language: string;
  apiKey: string | null;
  timeoutMs: number;
}

export const defaultSpeechConfig: SpeechConfig = {
  baseUrl: 'http://localhost:8082/v1',
  // El servidor expone el modelo cargado con este nombre. Coincide con lo que
  // pone el compose; si no coincidiera, la mayoría de los servidores ignoran el
  // campo y transcriben igual con el que tienen cargado.
  model: 'small',
  language: 'es',
  apiKey: null,
  timeoutMs: 600_000,
};

interface TranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
}

/**
 * Carril C (§8.1): notas de voz, contra un servidor de transcripción propio.
 *
 * El contrato es `POST /v1/audio/transcriptions` de OpenAI, y se eligió por ser
 * el que ya hablan casi todos los servidores de Whisper self-hosted. La
 * consecuencia práctica es la que se pidió: cambiar de motor —whisper.cpp,
 * faster-whisper, o la API de OpenAI si algún día conviene— es cambiar una URL,
 * no escribir un adapter.
 *
 * El servidor por defecto corre en el mismo compose, así que el audio no sale
 * del host. Eso sigue siendo lo importante: es el único de los tres carriles
 * donde los bytes pueden quedarse en casa sin perder calidad.
 */
export function speechConverter(cfg: SpeechConfig = defaultSpeechConfig): Converter {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
  const auth: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};

  return {
    async extract(input: ExtractInput) {
      const name = input.filename ?? `audio.${extensionOf(input.filename) || extensionForMediaType(input.mediaType)}`;

      const extra: Record<string, string> = { model: cfg.model, response_format: 'json' };
      // `language` vacío deja que el servidor detecte. Fijarlo en español mejora
      // bastante el resultado cuando el audio es corto o empieza con ruido.
      if (cfg.language) extra.language = cfg.language;

      const res = await postJson<TranscriptionResponse>({
        service: 'whisper',
        url,
        body: formWithFile(input.bytes, name, input.mediaType, extra),
        headers: auth,
        timeoutMs: cfg.timeoutMs,
      });

      return {
        text: (res.text ?? '').trim(),
        detail: {
          tool: 'whisper',
          model: cfg.model,
          ...(res.language ? { language: res.language } : {}),
          ...(res.duration ? { duration: res.duration } : {}),
        },
      };
    },

    async available() {
      // /models es parte de la API de OpenAI y lo exponen los servidores
      // compatibles: sirve de latido sin subir un audio de mentira.
      const base = cfg.baseUrl.replace(/\/$/, '');
      const state = await probe('whisper', `${base}/models`, 5_000, auth);
      if (!state.ok) return state;

      // Se reporta el modelo que el servidor tiene CARGADO, no el que pide la
      // config. La diferencia importa: en español `tiny` y `small` no son lo
      // mismo ni de lejos, y creer que corres uno mientras corres el otro es
      // justo el tipo de sorpresa que dm doctor existe para evitar.
      try {
        const res = await fetch(`${base}/models`, { headers: auth, signal: AbortSignal.timeout(5_000) });
        const body = (await res.json()) as { data?: { id?: string }[] };
        const cargado = body.data?.map((m) => m.id).filter(Boolean).join(', ');
        if (cargado) return { ok: true, detail: `${cargado} @ ${base}` };
      } catch {
        // El latido ya pasó; no saber el nombre exacto no es motivo de alarma.
      }
      return { ok: true, detail: `${cfg.model} @ ${base}` };
    },
  };
}
