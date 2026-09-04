import PgBoss from 'pg-boss';
import { normalizeMemory } from '../../core/normalize/run';
import type { Deps, Ingest } from '../../core/ports';

export const NORMALIZE_QUEUE = 'normalize';

/** Its own schema, so the queue's tables do not mix with yours. */
export const QUEUE_SCHEMA = 'pgboss';

interface NormalizeJob {
  memoryId: string;
}

/**
 * Arranca pg-boss y deja la cola creada. `start()` corre sus propias migraciones,
 * so there is nothing to add to the migrations — the queue is infrastructure, not
 * parte del modelo de datos.
 */
export async function startQueue(
  databaseUrl: string,
  // A capture lives half a second and only inserts a row: standing up the
  // maintenance supervisor on top of it is pure toll. That work belongs to the
  // worker, which does stay.
  opts: { supervise?: boolean } = {},
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: QUEUE_SCHEMA,
    supervise: opts.supervise ?? false,
    schedule: false,
  });
  // Without this, a connection error takes the whole process down over an unhandled
  // event. The worker has to survive the database restarting.
  boss.on('error', (e) => console.error(`[cola] ${e instanceof Error ? e.message : String(e)}`));
  await boss.start();
  if (!(await boss.getQueue(NORMALIZE_QUEUE))) {
    await boss.createQueue(NORMALIZE_QUEUE);
  }
  return boss;
}

/**
 * The normal path: capture enqueues and returns in milliseconds. It is what makes
 * the acknowledgement arrive in under a second even with a ten-second OCR pass
 * behind it.
 */
export function queueIngest(boss: PgBoss): Ingest {
  return {
    async process(memoryId: string): Promise<void> {
      await boss.send(NORMALIZE_QUEUE, { memoryId } satisfies NormalizeJob, {
        // Retries are for the database or the object store going down. A lane that fails
        // does not throw: it is recorded on the row and a reprocess picks it up.
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 30,
      });
    },
  };
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * One at a time and no parallelism by default. Not timidity: a hosted visual lane
 * is paid per token and the audio one eats a whole CPU. Going slowly is correct
 * when nobody is waiting on the other side.
 */
export async function runWorker(
  boss: PgBoss,
  deps: Deps,
  opts: { onDone?: (line: string) => void } = {},
): Promise<WorkerHandle> {
  const say = opts.onDone ?? ((line: string) => console.log(line));

  const id = await boss.work<NormalizeJob>(
    NORMALIZE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return;
      const result = await normalizeMemory(deps, job.data.memoryId);
      if (!result.ok) {
        // Not rethrown: retrying will not make a purged memory or a missing blob
        // appear. It is stated and the run continues.
        say(`✗ ${job.data.memoryId}  ${result.message}`);
        return;
      }
      const v = result.value;
      // The domain goes on the line because its absence was invisible for a whole
      // F2: quince documentos normalizados, ninguno categorizado, y el worker
      // diciendo ✓ en todos.
      const cat = v.domain ? ` → ${v.domain}` : '';
      say(v.error ? `⚠ ${v.shortId}  ${v.lane}  ${v.error}` : `✓ ${v.shortId}  ${v.lane}  ${v.chars} caracteres${cat}`);
    },
  );

  return {
    async stop() {
      await boss.offWork({ id });
      await boss.stop({ wait: true });
    },
  };
}
