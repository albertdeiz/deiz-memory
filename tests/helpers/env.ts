import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

/**
 * Los tests corren contra **tu mismo stack**, no contra contenedores paralelos.
 *
 * Duplicar Postgres, Garage y los tres servicios solo para probar significaba
 * bajar dos veces el modelo de Whisper y construir dos veces las imágenes, para
 * ejercitar exactamente el mismo código. Lo que de verdad hay que aislar es
 * mucho más chico: la base que los tests truncan y el bucket donde escriben.
 *
 * Y ese aislamiento no es negociable: `reset()` hace `truncate memories, blobs,
 * owners cascade`. Apuntado a tu base, eso borra todo lo que has guardado.
 */
if (existsSync('.env.local')) loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: process.env.DM_ENV_FILE ?? '.env', quiet: true });

export const TEST_DATABASE = 'deiz_memory_test';
export const TEST_BUCKET = process.env.DM_TEST_BUCKET ?? 'deiz-memory-test';

const swapDatabase = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL. Levanta el stack con "npm run up" antes de correr los tests.');
}

export const TEST_DATABASE_URL = swapDatabase(process.env.DATABASE_URL, TEST_DATABASE);

/** Lo que se le pasa a un proceso hijo (los tests del CLI levantan el binario). */
export const TEST_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  DATABASE_URL: TEST_DATABASE_URL,
  S3_BUCKET: TEST_BUCKET,
  // Sin esto, el binario cargaría .env y volvería a apuntar a la base real.
  DM_ENV_FILE: '/dev/null',
};

/**
 * Crea la base de pruebas si no existe. Idempotente, y a propósito NO la borra
 * al terminar: dejarla permite mirar qué quedó cuando un test falla.
 */
export async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: swapDatabase(process.env.DATABASE_URL!, 'postgres') });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [TEST_DATABASE]);
    if (rowCount === 0) await admin.query(`create database ${TEST_DATABASE}`);
  } finally {
    await admin.end();
  }
}
