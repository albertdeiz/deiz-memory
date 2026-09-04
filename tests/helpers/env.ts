import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

/**
 * Tests run against **your own stack**, not against parallel containers.
 *
 * Duplicating the database, the object store and the three services just to test
 * meant downloading the speech model twice and building the images twice, to
 * exercise exactly the same code. What genuinely has to be isolated is much
 * smaller: the database the tests truncate and the bucket they write to.
 *
 * And that isolation is not negotiable: the reset truncates the core tables with
 * a cascade. Pointed at your database, that erases everything you have stored.
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

/** What is handed to a child process: the CLI tests run the binary. */
export const TEST_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  DATABASE_URL: TEST_DATABASE_URL,
  S3_BUCKET: TEST_BUCKET,
  // Without this the binary would load .env and point back at the real database.
  DM_ENV_FILE: '/dev/null',
  // No classifier. These tests are about the queue and the lanes, and since the
  // pipeline classifies on its own, every capture was calling the real model:
  // tests en paralelo contra un modelo que atiende de a uno, y el timeout.
  // Classification has its own tests, with a fake classifier.
  DM_CLASSIFY_URL: '',
};

/**
 * Creates the test database if missing. Idempotent, and on purpose it does NOT
 * drop it afterwards: leaving it lets you inspect what a failing test left behind.
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
