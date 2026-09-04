import PgBoss from 'pg-boss';
import { normalizeMemory } from '../../core/normalize/run';
import type { Deps, Ingest } from '../../core/ports';

export const NORMALIZE_QUEUE = 'normalize';

/** Su propio esquema, para que las tablas de la cola no se mezclen con las tuyas. */
export const QUEUE_SCHEMA = 'pgboss';

interface NormalizeJob {
  memoryId: string;
}

/**
 * Arranca pg-boss y deja la cola creada. `start()` corre sus propias migraciones,
 * así que no hay nada que agregar a migrations/ — la cola es infraestructura, no
 * parte del modelo de datos.
 */
export async function startQueue(
  databaseUrl: string,
  // Un `dm capture` vive medio segundo y solo inserta una fila: levantarle
  // encima el supervisor de mantenimiento es puro peaje. Ese trabajo es del
  // worker, que sí se queda.
  opts: { supervise?: boolean } = {},
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: QUEUE_SCHEMA,
    supervise: opts.supervise ?? false,
    schedule: false,
  });
  // Sin esto, un error de conexión tumba el proceso entero por un evento sin
  // escuchar. El worker tiene que sobrevivir a que Postgres se reinicie.
  boss.on('error', (e) => console.error(`[cola] ${e instanceof Error ? e.message : String(e)}`));
  await boss.start();
  if (!(await boss.getQueue(NORMALIZE_QUEUE))) {
    await boss.createQueue(NORMALIZE_QUEUE);
  }
  return boss;
}

/**
 * El camino normal: capture() encola y vuelve en milisegundos. Es lo que hace
 * que "guardado ✓" llegue en menos de un segundo aunque detrás haya un OCR de
 * diez (§7, métrica de §15).
 */
export function queueIngest(boss: PgBoss): Ingest {
  return {
    async process(memoryId: string): Promise<void> {
      await boss.send(NORMALIZE_QUEUE, { memoryId } satisfies NormalizeJob, {
        // Los reintentos son para cuando se cae Postgres o el storage. Un carril
        // que falla no lanza: se anota en la fila y lo retoma dm reprocess.
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
 * De a uno y sin paralelismo por defecto. No es timidez: el carril de visión se
 * paga por token y el de audio se come una CPU entera. Ir despacio es lo
 * correcto cuando nadie está esperando del otro lado.
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
        // No se relanza: reintentar no va a hacer aparecer una memoria purgada
        // ni un blob que no está. Se dice y se sigue.
        say(`✗ ${job.data.memoryId}  ${result.message}`);
        return;
      }
      const v = result.value;
      // El dominio va en la línea porque su ausencia fue invisible durante toda
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
