import type pg from 'pg';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index.js';
import { runMigrations } from '../../src/adapters/db/postgres/migrate.js';
import { s3BlobStore } from '../../src/adapters/storage/s3.js';
import { inlineIngest } from '../../src/core/ingest.js';
import type { Clock, Converters, Deps } from '../../src/core/ports.js';
import { createOwner } from '../../src/core/index.js';
import { fakeConverters } from './converters.js';
import { ensureTestDatabase, TEST_BUCKET, TEST_DATABASE_URL } from './env.js';

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

export async function startStack(
  clock: Clock = fixedClock(),
  converters: Converters = fakeConverters(),
): Promise<TestStack> {
  await ensureTestDatabase();
  const pool = createPool(TEST_DATABASE_URL);
  const db = pgDb(pool);
  await runMigrations(db);

  const blobs = s3BlobStore({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION ?? 'garage',
    // Bucket aparte: los tests escriben blobs de verdad y no tienen por qué
    // dejarlos entre tus documentos.
    bucket: TEST_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  });

  // inlineIngest en los tests, no la cola: los carriles corren dentro de
  // capture() y una aserción justo después ve el resultado. Con pg-boss de por
  // medio, cada test sería una espera con reintentos.
  const deps = { db, blobs, clock, converters } as Deps;
  deps.ingest = inlineIngest(() => deps);

  const stack: TestStack = {
    deps,
    pool,
    ownerId: '',
    otherOwnerId: '',
    async reset() {
      await db.query('truncate memories, blobs, audit_log, channel_identities, pairing_codes, chat_sessions, owners restart identity cascade');
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
