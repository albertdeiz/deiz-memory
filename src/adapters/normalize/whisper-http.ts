import { extensionForMediaType, extensionOf } from '../../core/media';
import type { Converter, ExtractInput } from '../../core/ports';
import { formWithFile, postJson, probe } from './http';

export interface SpeechConfig {
  /** Base of an OpenAI-compatible API: it ends before the transcriptions path. */
  baseUrl: string;
  model: string;
  language: string;
  apiKey: string | null;
  timeoutMs: number;
}

export const defaultSpeechConfig: SpeechConfig = {
  baseUrl: 'http://localhost:8082/v1',
  // The server exposes its loaded model under this name. It matches the compose;
  // if it did not, most servers ignore the field and transcribe with whatever they
  // have loaded anyway.
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
 * The audio lane: voice notes, against a self-hosted transcription server.
 *
 * The contract is the OpenAI transcriptions endpoint, chosen because almost
 * every self-hosted speech server already speaks it. The practical consequence
 * is the one that was asked for: changing engine is changing a URL, with no
 * code to touch.
 * no escribir un adapter.
 *
 * The default server runs in the same compose, so audio never leaves the host.
 * That is what matters: it is the one lane of the three where the bytes can stay
 * home without losing quality.
 */
export function speechConverter(cfg: SpeechConfig = defaultSpeechConfig): Converter {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
  const auth: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};

  return {
    async extract(input: ExtractInput) {
      const name = input.filename ?? `audio.${extensionOf(input.filename) || extensionForMediaType(input.mediaType)}`;

      const extra: Record<string, string> = { model: cfg.model, response_format: 'json' };
      // An empty language lets the server detect. Pinning it improves the result
      // noticeably when the audio is short or starts with noise.
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
      // The models endpoint is part of the same API and compatible servers expose it:
      // it works as a heartbeat without uploading a fake audio file.
      const base = cfg.baseUrl.replace(/\/$/, '');
      const state = await probe('whisper', `${base}/models`, 5_000, auth);
      if (!state.ok) return state;

      // The model reported is the one the server has LOADED, not the one config asks
      // for. The difference matters: the small and tiny variants are nowhere near the
      // same in Spanish, and believing you run one while running the other is exactly
      // the kind of surprise the health check exists to prevent.
      try {
        const res = await fetch(`${base}/models`, { headers: auth, signal: AbortSignal.timeout(5_000) });
        const body = (await res.json()) as { data?: { id?: string }[] };
        const cargado = body.data?.map((m) => m.id).filter(Boolean).join(', ');
        if (cargado) return { ok: true, detail: `${cargado} @ ${base}` };
      } catch {
        // The heartbeat already passed; not knowing the exact name is not alarming.
      }
      return { ok: true, detail: `${cfg.model} @ ${base}` };
    },
  };
}
