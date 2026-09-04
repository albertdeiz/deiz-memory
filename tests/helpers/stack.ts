import type pg from 'pg';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index';
import { runMigrations } from '../../src/adapters/db/postgres/migrate';
import { s3BlobStore } from '../../src/adapters/storage/s3';
import { inlineIngest } from '../../src/core/ingest';
import type { Clock, Converters, Deps } from '../../src/core/ports';
import { createOwner } from '../../src/core/index';
import { fakeConverters } from './converters';
import { ensureTestDatabase, TEST_BUCKET, TEST_DATABASE_URL } from './env';

/** Fixed clock: without it, any assertion about dates is a race. */
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
    // Separate bucket: the tests write real blobs and have no business
    // dejarlos entre tus documentos.
    bucket: TEST_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  });

  // Inline ingest in tests, not the queue: the lanes run inside capture and an
  // assertion right after sees the result. With the queue in between, every test
  // would be a wait with retries.
  const deps = { db, blobs, clock, converters, classifier: null, embedder: null } as Deps;
  deps.ingest = inlineIngest(() => deps);

  const stack: TestStack = {
    deps,
    pool,
    ownerId: '',
    otherOwnerId: '',
    async reset() {
      await db.query('truncate memories, memory_chunks, blobs, audit_log, channel_identities, pairing_codes, chat_sessions, domains, owners restart identity cascade');
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
