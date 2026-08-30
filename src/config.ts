import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import type { S3Config } from './adapters/storage/s3.js';

export interface Config {
  databaseUrl: string;
  s3: S3Config;
  ownerId: string | null;
}

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
  };
}
