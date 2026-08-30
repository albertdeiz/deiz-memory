import { loadConfig } from '../src/config.js';
import { createPool, pgDb } from '../src/adapters/db/postgres/index.js';
import { runMigrations } from '../src/adapters/db/postgres/migrate.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
try {
  const { applied } = await runMigrations(pgDb(pool));
  for (const f of applied) console.log(`✓ ${f}`);
  console.log(applied.length === 0 ? 'Sin migraciones pendientes.' : `${applied.length} migración(es) aplicada(s).`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
