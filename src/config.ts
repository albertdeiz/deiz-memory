import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import type { S3Config } from './adapters/storage/s3';
import type { NormalizeConfig, VisionBackend } from './adapters/normalize/index';
import type { TelegramConfig } from './adapters/chat/telegram/index';
import type { ClassifyConfig } from './adapters/classify/ollama';
import { defaultClassifyConfig } from './adapters/classify/ollama';
import type { EmbedConfig } from './adapters/classify/embed';
import { defaultEmbedConfig } from './adapters/classify/embed';
import {
  defaultDocumentsConfig, defaultOcrConfig, defaultSpeechConfig,
  defaultVisionConfig, defaultVisionHttpConfig, VISION_BACKENDS,
} from './adapters/normalize/index';

export interface Config {
  databaseUrl: string;
  s3: S3Config;
  ownerId: string | null;
  normalize: NormalizeConfig;
  telegram: TelegramConfig | null;
  classify: ClassifyConfig;
  embed: EmbedConfig;
}

type VisionEffort = 'low' | 'medium' | 'high';

/**
 * An unknown backend falls back to the default with a warning, rather than
 * leaving the lane silently off: a typo should not look like a decision.
 */
const visionBackend = (): VisionBackend => {
  const raw = process.env.DM_VISION_BACKEND;
  // El default es el OCR local: gratis, sin red, reproducible, y en documentos
  // printed documents better than a small model exactly where it matters: digits.
  if (!raw) return 'ocr';
  if ((VISION_BACKENDS as readonly string[]).includes(raw)) return raw as VisionBackend;
  console.error(
    `DM_VISION_BACKEND="${raw}" no existe. Válidos: ${VISION_BACKENDS.join(', ')}. Uso "ocr".`,
  );
  return 'ocr';
};

/**
 * Un `Number('mucho')` da NaN, y Node aplica el timeout solo `if (timeout > 0)`:
 * NaN is not, so the timeout silently switches off and nothing kills a hung
 * process. A garbage value has to fall back to the default, not disarm the
 * only defence against a service that does not answer.
 */
const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};

const need = (key: string): string => {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `Falta ${key}. Levanta el stack con "npm run up" — el script escribe las credenciales en .env.`,
    );
  }
  return v;
};

export function loadConfig(): Config {
  const envFile = process.env.DM_ENV_FILE ?? '.env';

  // `.env.local` primero, y no es un detalle de orden: `npm run up` reescribe
  // the whole .env every run, so a provider key placed there lasts until the next
  // stack start. The loader does not overwrite what is already loaded, so loading
  // the local file first is what makes your keys win and
  // sobrevivan.
  if (existsSync('.env.local')) loadEnv({ path: '.env.local', quiet: true });
  if (existsSync(envFile)) loadEnv({ path: envFile, quiet: true });

  return {
    databaseUrl: need('DATABASE_URL'),
    s3: {
      endpoint: need('S3_ENDPOINT'),
      region: process.env.S3_REGION ?? 'garage',
      bucket: need('S3_BUCKET'),
      accessKeyId: need('S3_ACCESS_KEY_ID'),
      secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
    },
    ownerId: process.env.DM_OWNER_ID ?? null,
    // Null when there is no token, and that is a legitimate state: the system works
    // over the CLI with no channel. The health check reports it as unconfigured,
    // no como roto.
    telegram: process.env.TELEGRAM_BOT_TOKEN
      ? {
          token: process.env.TELEGRAM_BOT_TOKEN,
          apiRoot: process.env.TELEGRAM_API_ROOT,
          // Con un servidor Bot API local el techo de 20 MB desaparece.
          maxDownloadBytes: positive(process.env.DM_TELEGRAM_MAX_DOWNLOAD, 20 * 1024 * 1024),
        }
      : null,
    classify: {
      baseUrl: process.env.DM_CLASSIFY_URL ?? defaultClassifyConfig.baseUrl,
      model: process.env.DM_CLASSIFY_MODEL ?? defaultClassifyConfig.model,
      apiKey: process.env.DM_CLASSIFY_API_KEY ?? null,
      timeoutMs: positive(process.env.DM_CLASSIFY_TIMEOUT_MS, defaultClassifyConfig.timeoutMs),
    },
    embed: {
      baseUrl: process.env.DM_EMBED_URL ?? defaultEmbedConfig.baseUrl,
      model: process.env.DM_EMBED_MODEL ?? defaultEmbedConfig.model,
      // Changing model changes this dimension and forces a reindex: the schema
      // declares a fixed vector width and another size simply does not fit.
      dimensions: positive(process.env.DM_EMBED_DIMS, defaultEmbedConfig.dimensions),
      apiKey: process.env.DM_EMBED_API_KEY ?? null,
      timeoutMs: positive(process.env.DM_EMBED_TIMEOUT_MS, defaultEmbedConfig.timeoutMs),
    },
    normalize: {
      documents: {
        baseUrl: process.env.DM_DOCUMENTS_URL ?? defaultDocumentsConfig.baseUrl,
        timeoutMs: positive(process.env.DM_DOCUMENTS_TIMEOUT_MS, defaultDocumentsConfig.timeoutMs),
      },
      vision: {
        backend: visionBackend(),
        ocr: {
          baseUrl: process.env.DM_OCR_URL ?? defaultOcrConfig.baseUrl,
          timeoutMs: positive(process.env.DM_OCR_TIMEOUT_MS, defaultOcrConfig.timeoutMs),
        },
        anthropic: {
          model: process.env.DM_VISION_MODEL ?? defaultVisionConfig.model,
          effort: (process.env.DM_VISION_EFFORT ?? defaultVisionConfig.effort) as VisionEffort,
          maxTokens: positive(process.env.DM_VISION_MAX_TOKENS, defaultVisionConfig.maxTokens),
          // Without this the SDK still looks for credentials on its own: the variable
          // being absent does not mean there is no key.
          apiKey: process.env.ANTHROPIC_API_KEY,
        },
        openai: {
          baseUrl: process.env.DM_VISION_URL ?? defaultVisionHttpConfig.baseUrl,
          model: process.env.DM_VISION_MODEL ?? defaultVisionHttpConfig.model,
          apiKey: process.env.DM_VISION_API_KEY ?? null,
          maxTokens: positive(process.env.DM_VISION_MAX_TOKENS, defaultVisionHttpConfig.maxTokens),
          timeoutMs: positive(process.env.DM_VISION_TIMEOUT_MS, defaultVisionHttpConfig.timeoutMs),
        },
      },
      speech: {
        baseUrl: process.env.DM_SPEECH_URL ?? defaultSpeechConfig.baseUrl,
        model: process.env.DM_SPEECH_MODEL ?? defaultSpeechConfig.model,
        language: process.env.DM_SPEECH_LANG ?? defaultSpeechConfig.language,
        apiKey: process.env.DM_SPEECH_API_KEY ?? null,
        timeoutMs: positive(process.env.DM_SPEECH_TIMEOUT_MS, defaultSpeechConfig.timeoutMs),
      },
    },
  };
}
