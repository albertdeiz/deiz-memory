import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import type { S3Config } from './adapters/storage/s3.js';
import type { NormalizeConfig, VisionBackend } from './adapters/normalize/index.js';
import type { TelegramConfig } from './adapters/chat/telegram/index.js';
import {
  defaultDocumentsConfig, defaultOcrConfig, defaultSpeechConfig,
  defaultVisionConfig, defaultVisionHttpConfig, VISION_BACKENDS,
} from './adapters/normalize/index.js';

export interface Config {
  databaseUrl: string;
  s3: S3Config;
  ownerId: string | null;
  normalize: NormalizeConfig;
  telegram: TelegramConfig | null;
}

type VisionEffort = 'low' | 'medium' | 'high';

/**
 * Un backend desconocido cae al default con un aviso, en vez de dejar el carril
 * apagado en silencio: un typo en el .env no debería parecer una decisión.
 */
const visionBackend = (): VisionBackend => {
  const raw = process.env.DM_VISION_BACKEND;
  // El default es el OCR local: gratis, sin red, reproducible, y en documentos
  // impresos mejor que un modelo chico justo donde importa (los dígitos).
  if (!raw) return 'ocr';
  if ((VISION_BACKENDS as readonly string[]).includes(raw)) return raw as VisionBackend;
  console.error(
    `DM_VISION_BACKEND="${raw}" no existe. Válidos: ${VISION_BACKENDS.join(', ')}. Uso "ocr".`,
  );
  return 'ocr';
};

/**
 * Un `Number('mucho')` da NaN, y Node aplica el timeout solo `if (timeout > 0)`:
 * NaN no lo es, así que el timeout se apaga en silencio y un proceso colgado no
 * lo mata nadie. Un valor basura tiene que caer al default, no desarmar la
 * única defensa contra un servicio que no responde.
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
  // .env entero cada vez que corre, así que una ANTHROPIC_API_KEY puesta ahí
  // dura hasta el próximo arranque del stack. dotenv no pisa lo ya cargado, de
  // modo que cargar local primero es lo que hace que tus llaves ganen y
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
    // `null` cuando no hay token, y eso es un estado legítimo: el sistema
    // funciona por CLI sin canal. `dm doctor` lo reporta como no configurado,
    // no como roto.
    telegram: process.env.TELEGRAM_BOT_TOKEN
      ? {
          token: process.env.TELEGRAM_BOT_TOKEN,
          apiRoot: process.env.TELEGRAM_API_ROOT,
          // Con un servidor Bot API local el techo de 20 MB desaparece.
          maxDownloadBytes: positive(process.env.DM_TELEGRAM_MAX_DOWNLOAD, 20 * 1024 * 1024),
        }
      : null,
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
          // Sin esto el SDK igual busca credenciales por su cuenta (perfil de
          // `ant auth login`): que no esté la variable no significa que no haya key.
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
