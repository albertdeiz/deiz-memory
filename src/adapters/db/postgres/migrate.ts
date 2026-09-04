import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../../core/ports';

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Idempotente: lo usan el script de migración y el arranque de los tests. */
export async function runMigrations(db: Db, dir = 'migrations'): Promise<MigrationResult> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query<{ name: string }>('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.tx(async (tx) => {
      await tx.query(sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return { applied, alreadyApplied: [...done] };
}
