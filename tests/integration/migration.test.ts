import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index.js';
import { runMigrations } from '../../src/adapters/db/postgres/migrate.js';

import '../helpers/env.js';

/**
 * Una migración solo corre una vez, así que la única forma de probarla es
 * levantar una base virgen, dejarla como la habría dejado F0, y mirar qué
 * sobrevive.
 *
 * Vale la pena hacerlo por una razón concreta: la primera versión de 003 dejaba
 * fuera del backfill a las memorias con archivo, y en una base real de F0 eso
 * eran 159 de 167 filas. Como la nota es lo único que NO se regenera desde el
 * blob, el primer `dm reprocess --pending` las habría borrado todas y para
 * siempre. Este test es la red para que eso no vuelva a pasar.
 */
const DB = 'deiz_memory_migration_test';

let admin: pg.Client;
let pool: pg.Pool;

const adminUrl = () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/postgres';
  return url.toString();
};
const targetUrl = () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${DB}`;
  return url.toString();
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`drop database if exists ${DB}`);
  await admin.query(`create database ${DB}`);
  pool = createPool(targetUrl());
}, 60_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await admin.query(`drop database if exists ${DB}`).catch(() => {});
  await admin.end().catch(() => {});
});

describe('003 · el backfill de notas', () => {
  it('no pierde ni una nota de F0, tenga archivo o no', async () => {
    const db = pgDb(pool);

    // --- Estado de F0: SOLO 001 y 002. Se copian a un directorio aparte para
    // que runMigrations no aplique 003 todavía; los nombres se conservan, así
    // que schema_migrations queda coherente y después solo falta 003.
    const f0 = await mkdtemp(join(tmpdir(), 'dm-mig-'));
    for (const f of ['001_init.sql', '002_search_weights.sql']) {
      await copyFile(join('migrations', f), join(f0, f));
    }
    await runMigrations(db, f0);
    await rm(f0, { recursive: true, force: true });

    const { rows: [owner] } = await db.query<{ id: string }>(
      `insert into owners (label) values ('yo') returning id`,
    );
    await db.query(
      `insert into blobs (sha256, size_bytes, media_type, storage_key) values
         ('aa', 10, 'image/jpeg', 'blobs/aa/aa/aa'),
         ('bb', 10, 'text/plain', 'blobs/bb/bb/bb')`,
    );

    // Así guardaba F0: la nota iba a normalized_text. Para un blob que no es
    // texto, `fromFile` era siempre null, o sea que ese campo era *solo* la nota.
    await db.query(
      `insert into memories (owner_id, source, blob_sha256, original_filename, normalized_text) values
         ($1, 'cli', 'aa', 'IMG_0001.jpg', 'la boleta del taller de la Rosita'),
         ($1, 'cli', 'bb', 'notas.txt',    'contenido del archivo'),
         ($1, 'cli', null, null,           'el corredor es Pedro')`,
      [owner!.id],
    );

    // --- Ahora sí, 003.
    const { applied } = await runMigrations(db, 'migrations');
    expect(applied).toEqual(['003_normalization.sql']);

    const { rows } = await db.query<{ note: string | null; normalized_text: string | null }>(
      `select note, normalized_text from memories order by note`,
    );

    // Ninguna nota se perdió. La de la foto es la que importa: es la que la
    // primera versión de esta migración dejaba fuera, y la que el primer OCR
    // habría borrado sin dejar rastro.
    expect(rows.map((r) => r.note)).toEqual([
      'contenido del archivo',
      'el corredor es Pedro',
      'la boleta del taller de la Rosita',
    ]);
    // Y el campo regenerable queda limpio, listo para que lo escriba el carril.
    expect(rows.every((r) => r.normalized_text === null)).toBe(true);
  }, 120_000);

  it('deja el esquema con las columnas y la restricción de F1', async () => {
    const db = pgDb(pool);
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'memories'
          and column_name in ('note','normalization_lane','normalized_at','normalization_error','normalization_detail')
        order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'normalization_detail', 'normalization_error', 'normalization_lane', 'normalized_at', 'note',
    ]);

    // Una memoria de solo nota tiene que ser válida: si el check no la acepta,
    // el propio backfill de 003 deja la tabla inconsistente.
    const { rows: [o] } = await db.query<{ id: string }>(`select id from owners limit 1`);
    await expect(
      db.query(`insert into memories (owner_id, source, note) values ($1,'cli','solo una nota')`, [o!.id]),
    ).resolves.toBeTruthy();
  }, 60_000);

  it('la búsqueda alcanza la nota rescatada', async () => {
    // Rescatarla y que no sea buscable sería medio rescate.
    const db = pgDb(pool);
    const { rows } = await db.query(
      `select 1 from memories
        where search_tsv @@ websearch_to_tsquery('es_unaccent', 'boleta taller')`,
    );
    expect(rows).toHaveLength(1);
  }, 60_000);
});
