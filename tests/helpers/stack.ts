import { config as loadEnv } from 'dotenv';
import type pg from 'pg';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index.js';
import { runMigrations } from '../../src/adapters/db/postgres/migrate.js';
import { s3BlobStore } from '../../src/adapters/storage/s3.js';
import { inlineIngest } from '../../src/core/ingest.js';
import type { Clock, Deps } from '../../src/core/ports.js';
import { createOwner } from '../../src/core/index.js';

export const TEST_ENV_FILE = process.env.DM_ENV_FILE ?? '.env.test';
loadEnv({ path: TEST_ENV_FILE, quiet: true });

/** Reloj fijo: sin esto, cualquier aserción sobre fechas es una carrera. */
export const fixedClock = (iso = '2026-03-14T12:00:00.000Z'): Clock => ({ now: () => new Date(iso) });

export interface TestStack {
  deps: Deps;
  pool: pg.Pool;
  ownerId: string;
  otherOwnerId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startStack(clock: Clock = fixedClock()): Promise<TestStack> {
  const pool = createPool(process.env.DATABASE_URL!);
  const db = pgDb(pool);
  await runMigrations(db);

  const blobs = s3BlobStore({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION ?? 'garage',
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  });

  const deps: Deps = { db, blobs, clock, ingest: inlineIngest(db) };

  const stack: TestStack = {
    deps,
    pool,
    ownerId: '',
    otherOwnerId: '',
    async reset() {
      await db.query('truncate memories, blobs, audit_log, owners restart identity cascade');
      const mine = await createOwner(db, 'yo');
      const other = await createOwner(db, 'alguien más');
      if (!mine.ok || !other.ok) throw new Error('no se pudieron crear los dueños de prueba');
      stack.ownerId = mine.value.id;
      stack.otherOwnerId = other.value.id;
    },
    async close() {
      await pool.end();
    },
  };

  await stack.reset();
  return stack;
}
