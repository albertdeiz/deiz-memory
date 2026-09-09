import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKED_UP_TABLES, NOT_BACKED_UP, capture, checkExport, exportOwner, importInto,
  readBackupConfig, recordBackupRun, secretsNeededBy, setBackupDestination, storageKey,
  type BackupManifest, type CheckReport,
} from '../../src/core/index';
import { fsSink, fsSource } from '../../src/adapters/backup/fs';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index';
import { runMigrations } from '../../src/adapters/db/postgres/migrate';
import { TEST_DATABASE_URL } from '../helpers/env';
import { startStack, type TestStack } from '../helpers/stack';

let s: TestStack;
const mine = () => ({ ownerId: s.ownerId });
const theirs = () => ({ ownerId: s.otherOwnerId });
const unwrap = <T>(r: any): T => {
  if (!r.ok) throw new Error(`esperaba ok, vino ${r.kind}: ${r.message}`);
  return r.value as T;
};

let dirs: string[] = [];
const staging = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dm-backup-test-'));
  dirs.push(d);
  return d;
};

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); });
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await s.close();
});

describe('el respaldo es de una persona, no del sistema', () => {
  it('no se lleva ni una fila del otro dueño', async () => {
    await capture(s.deps, mine(), { text: 'mi póliza', title: 'Mía' });
    await capture(s.deps, theirs(), { text: 'la póliza de otro', title: 'Ajena' });

    const dir = staging();
    const manifest = unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(dir)));

    expect(manifest.ownerId).toBe(s.ownerId);
    expect(manifest.tables.memories).toBe(1);
    // El otro dueño existe y tiene datos; el respaldo no los ve.
    expect(manifest.tables.owners).toBe(1);

    const src = fsSource(dir);
    const memories = await src.table('memories');
    expect(memories.map((m) => m.title)).toEqual(['Mía']);
    const owners = await src.table('owners');
    expect(owners.map((o) => o.id)).toEqual([s.ownerId]);
  });

  it('trae el blob de una memoria propia y no el de una ajena', async () => {
    const mineCap: any = await capture(s.deps, mine(), { bytes: Buffer.from('mío'), filename: 'a.txt' });
    const theirsCap: any = await capture(s.deps, theirs(), { bytes: Buffer.from('ajeno'), filename: 'b.txt' });

    const dir = staging();
    unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(dir)));
    const src = fsSource(dir);

    await expect(src.blob(storageKey(mineCap.value.sha256))).resolves.toBeInstanceOf(Buffer);
    // `blobs` no tiene owner_id (§14.1): la pertenencia solo se lee por el join
    // con memories, y esto es lo que prueba que el join es el filtro.
    await expect(src.blob(storageKey(theirsCap.value.sha256))).rejects.toThrow();
  });

  it('el mismo archivo de dos dueños viaja en los dos respaldos', async () => {
    // Dedup por contenido: un blob, dos memorias, dos dueños. Cada respaldo
    // tiene que ser completo por sí solo — no se puede restaurar a medias
    // porque el vecino comparta el archivo.
    const bytes = Buffer.from('el mismo PDF');
    const a: any = await capture(s.deps, mine(), { bytes, filename: 'x.txt' });
    const b: any = await capture(s.deps, theirs(), { bytes, filename: 'x.txt' });
    expect(a.value.sha256).toBe(b.value.sha256);

    const da = staging();
    const db = staging();
    unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(da)));
    unwrap<BackupManifest>(await exportOwner(s.deps, theirs(), fsSink(db)));

    const key = storageKey(a.value.sha256);
    await expect(fsSource(da).blob(key)).resolves.toBeInstanceOf(Buffer);
    await expect(fsSource(db).blob(key)).resolves.toBeInstanceOf(Buffer);
  });
});

describe('ninguna tabla se queda afuera por olvido', () => {
  it('toda tabla del esquema se respalda o está excluida a propósito', async () => {
    const { rows } = await s.deps.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const known = new Set([...BACKED_UP_TABLES, ...NOT_BACKED_UP]);
    // pg-boss trae su propio esquema; lo de acá es lo que vive en public.
    const orphans = rows.map((r) => r.table_name).filter((t) => !known.has(t) && !t.startsWith('pgboss'));
    expect(orphans).toEqual([]);
  });
});

describe('checkExport encuentra las formas en que este diseño puede fallar', () => {
  it('un respaldo entero no tiene problemas', async () => {
    await capture(s.deps, mine(), { bytes: Buffer.from('contenido'), filename: 'a.txt' });
    const dir = staging();
    unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(dir)));

    const report = unwrap<CheckReport>(await checkExport(fsSource(dir)));
    expect(report.problems).toEqual([]);
    expect(report.blobsHashed).toBe(1);
  });

  it('delata una memoria cuyo blob no viajó', async () => {
    const cap: any = await capture(s.deps, mine(), { bytes: Buffer.from('contenido'), filename: 'a.txt' });
    const dir = staging();
    unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(dir)));

    // El modo de falla real de un export filtrado: la fila queda y el archivo no.
    unlinkSync(join(dir, storageKey(cap.value.sha256)));

    const report = unwrap<CheckReport>(await checkExport(fsSource(dir)));
    expect(report.problems.join(' ')).toContain('falta el archivo del blob');
  });

  it('delata un blob cuyo contenido no calza con su nombre', async () => {
    const cap: any = await capture(s.deps, mine(), { bytes: Buffer.from('contenido'), filename: 'a.txt' });
    const dir = staging();
    unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(dir)));

    // El nombre ES el sha256, así que corromper el contenido es detectable sin
    // guardar ningún checksum aparte.
    await fsSink(dir).blob(storageKey(cap.value.sha256), Buffer.from('otra cosa'));

    const report = unwrap<CheckReport>(await checkExport(fsSource(dir)));
    expect(report.problems.join(' ')).toContain('no coincide con su contenido');
  });

  it('delata una fila de otro dueño metida a mano', async () => {
    await capture(s.deps, mine(), { text: 'mío' });
    const dir = staging();
    const manifest = unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(dir)));

    const rows = [...(await fsSource(dir).table('memories'))];
    rows.push({ ...rows[0], id: '00000000-0000-0000-0000-000000000009', owner_id: s.otherOwnerId });
    await fsSink(dir).table('memories', rows);
    // El manifiesto sigue diciendo la cuenta vieja: las dos cosas se delatan.
    expect(manifest.tables.memories).toBe(1);

    const report = unwrap<CheckReport>(await checkExport(fsSource(dir)));
    expect(report.problems.join(' ')).toContain('trae filas de otro dueño');
    expect(report.problems.join(' ')).toContain('el manifiesto dice 1 filas y hay 2');
  });
});

describe('importInto: lo único que prueba que restaura', () => {
  it('carga el respaldo en una base limpia con las mismas cuentas', async () => {
    await capture(s.deps, mine(), { bytes: Buffer.from('un archivo'), filename: 'a.txt' });
    await capture(s.deps, mine(), { text: 'una nota' });

    const dir = staging();
    const manifest = unwrap<BackupManifest>(await exportOwner(s.deps, mine(), fsSink(dir)));

    // Base desechable de verdad: el esquema desde las migraciones y nada más.
    const name = 'deiz_memory_restore_test';
    const admin = createPool(TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres'));
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    await admin.end();

    const pool = createPool(TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${name}`));
    try {
      const db = pgDb(pool);
      await runMigrations(db);
      const loaded = unwrap<Record<string, number>>(await importInto(db, fsSource(dir)));

      expect(loaded.memories).toBe(manifest.tables.memories);
      // Los vectores y los jsonb son los que rompen un import ingenuo, así que
      // se cuentan en la base y no en el manifiesto.
      const chunks = await db.query<{ n: string }>('select count(*)::text as n from memory_chunks');
      expect(Number(chunks.rows[0]!.n)).toBe(manifest.tables.memory_chunks);
      const types = await db.query<{ fields: unknown }>('select fields from fact_types limit 1');
      if (types.rows.length > 0) expect(Array.isArray(types.rows[0]!.fields)).toBe(true);
    } finally {
      await pool.end();
      const drop = createPool(TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres'));
      await drop.query(`drop database if exists ${name}`);
      await drop.end();
    }
  }, 60_000);
});

describe('la dirección es del dueño, los secretos no', () => {
  it('empieza sin destino y guarda el que le pongas', async () => {
    expect(unwrap<unknown>(await readBackupConfig(s.deps, mine()))).toBeNull();

    unwrap<unknown>(await setBackupDestination(s.deps, mine(), { repository: 'b2:bucket:ruta' }));
    const cfg: any = unwrap(await readBackupConfig(s.deps, mine()));
    expect(cfg.repository).toBe('b2:bucket:ruta');
    expect(cfg.transport).toBe('none');
    expect(cfg.lastRunAt).toBeNull();
    expect(cfg.lastOk).toBeNull();
  });

  it('guarda la URL y el usuario del WebDAV, que no son secretos', async () => {
    unwrap<unknown>(await setBackupDestination(s.deps, mine(), {
      repository: 'rclone:nc:deiz-memory',
      transport: 'webdav',
      transportConfig: { url: 'https://cloud.example/remote.php/dav/files/yo/', user: 'yo' },
    }));

    const cfg: any = unwrap(await readBackupConfig(s.deps, mine()));
    expect(cfg.transport).toBe('webdav');
    expect(cfg.transportConfig.url).toBe('https://cloud.example/remote.php/dav/files/yo/');
    expect(cfg.transportConfig.user).toBe('yo');
    // La credencial es lo único que no está acá.
    expect(secretsNeededBy(cfg)).toContain('transport');
  });

  it('rechaza la URL del navegador, que es el error que todos cometen una vez', async () => {
    // Falla como un error de autenticación opaco horas después; decirlo ahora
    // no cuesta nada.
    const bad = await setBackupDestination(s.deps, mine(), {
      repository: 'rclone:nc:x',
      transport: 'webdav',
      transportConfig: { url: 'https://cloud.example/apps/files/', user: 'yo' },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('/remote.php/dav/');
  });

  it('un destino webdav sin usuario se rechaza al guardarlo, no al correrlo', async () => {
    const bad = await setBackupDestination(s.deps, mine(), {
      repository: 'rclone:nc:x',
      transport: 'webdav',
      transportConfig: { url: 'https://cloud.example/remote.php/dav/files/yo/' },
    });
    expect(bad.ok).toBe(false);
  });

  it('un destino de un dueño no es visible para el otro', async () => {
    unwrap<unknown>(await setBackupDestination(s.deps, mine(), { repository: 'rclone:nc:mio' }));
    expect(unwrap<unknown>(await readBackupConfig(s.deps, theirs()))).toBeNull();
  });

  it('cada dueño puede tener su propio Nextcloud', async () => {
    unwrap<unknown>(await setBackupDestination(s.deps, mine(), {
      repository: 'rclone:nc:a', transport: 'webdav',
      transportConfig: { url: 'https://a.example/remote.php/dav/files/a/', user: 'a' },
    }));
    unwrap<unknown>(await setBackupDestination(s.deps, theirs(), {
      repository: 'rclone:nc:b', transport: 'webdav',
      transportConfig: { url: 'https://b.example/remote.php/dav/files/b/', user: 'b' },
    }));

    const a: any = unwrap(await readBackupConfig(s.deps, mine()));
    const b: any = unwrap(await readBackupConfig(s.deps, theirs()));
    expect(a.transportConfig.user).toBe('a');
    expect(b.transportConfig.user).toBe('b');
  });

  it('separa "nunca corrió" de "corrió y falló"', async () => {
    unwrap<unknown>(await setBackupDestination(s.deps, mine(), { repository: '/tmp/x' }));
    unwrap<unknown>(await recordBackupRun(s.deps, mine(), { ok: false, error: 'sin red' }));

    const cfg: any = unwrap(await readBackupConfig(s.deps, mine()));
    expect(cfg.lastRunAt).not.toBeNull();
    expect(cfg.lastOk).toBe(false);
    expect(cfg.lastError).toBe('sin red');
    // Copiar y probar que se puede volver son afirmaciones distintas.
    expect(cfg.lastVerifiedAt).toBeNull();
  });

  it('ninguna columna guarda un secreto', async () => {
    // La passphrase en la base haría que un host robado entregue un archivo
    // off-site legible, que es justo lo que el off-site existe para sobrevivir.
    const { rows } = await s.deps.db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'backup_config'`,
    );
    const names = rows.map((r) => r.column_name).join(' ');
    expect(names).not.toMatch(/pass|secret|token|credential/i);
  });
});
