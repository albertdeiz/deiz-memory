import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index.js';
import { runMigrations } from '../../src/adapters/db/postgres/migrate.js';
import { ensureTestDatabase, TEST_DATABASE_URL, TEST_ENV } from '../helpers/env.js';

const BIN = 'dist/adapters/cli/index.js';
// Tu mismo stack, pero con la base y el bucket de pruebas: el binario recibe
// las variables por entorno en vez de leer un .env propio.
const ENV = TEST_ENV;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

/** Levanta el binario compilado como lo haría una persona. Esto reemplaza la prueba manual. */
const dm = (args: string[], stdin?: string): Promise<Run> =>
  new Promise((resolve) => {
    const child = execFile('node', [BIN, ...args], { env: ENV, maxBuffer: 16 << 20 },
      (error, stdout, stderr) => {
        // El valor sale por stdout y los fallos por stderr: se intentan ambos.
        let json: any;
        for (const stream of [stdout, stderr]) {
          try { json = JSON.parse(stream); break; } catch { /* sigue */ }
        }
        resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr, json });
      });
    if (stdin !== undefined) { child.stdin?.write(stdin); child.stdin?.end(); }
  });

const pool = createPool(TEST_DATABASE_URL);
const db = pgDb(pool);

beforeAll(async () => { await ensureTestDatabase(); await runMigrations(db); }, 60_000);
beforeEach(async () => {
  await db.query('truncate memories, blobs, audit_log, channel_identities, pairing_codes, chat_sessions, domains, owners restart identity cascade');
  const init = await dm(['--json', 'init', 'yo']);
  expect(init.code).toBe(0);
});
afterAll(async () => { await pool.end(); });

const shortIdOf = (r: Run): string => r.json.shortId;

describe('recorrido completo por CLI', () => {
  it('init es idempotente y doctor sale en verde', async () => {
    const again = await dm(['--json', 'init', 'yo']);
    expect(again.code).toBe(0);

    const doctor = await dm(['--json', 'doctor']);
    expect(doctor.code).toBe(0);
    // Lo obligatorio en verde. Los carriles se reportan pero no mandan sobre el
    // código de salida: no tener whisper instalado no es un sistema roto.
    expect(doctor.json.filter((c: any) => c.required).every((c: any) => c.ok)).toBe(true);
    expect(doctor.json.map((c: any) => c.check)).toContain('garage');
    expect(doctor.json.map((c: any) => c.check)).toContain('carril foto');
  });

  it('captura texto, archivo y stdin, y los lista', async () => {
    const t = await dm(['--json', 'capture', '--text', 'el mecánico es Juan']);
    expect(t.code).toBe(0);
    expect(t.json.sha256).toBeNull();

    const f = await dm(['--json', 'capture', 'fixtures/poliza.pdf', '--title', 'Póliza auto']);
    expect(f.json.mediaType).toBe('application/pdf');

    const s = await dm(['--json', 'capture', '-'], 'clave del wifi en el router\n');
    expect(s.code).toBe(0);

    const ls = await dm(['--json', 'ls']);
    expect(ls.json).toHaveLength(3);
  });

  it('el mismo archivo dos veces avisa que ya lo tenías', async () => {
    const a = await dm(['--json', 'capture', 'fixtures/poliza.pdf']);
    const b = await dm(['--json', 'capture', 'fixtures/poliza.pdf']);
    expect(a.json.deduped).toBe(false);
    expect(b.json.deduped).toBe(true);
    expect(b.json.sha256).toBe(a.json.sha256);

    const human = await dm(['capture', 'fixtures/poliza.pdf']);
    expect(human.stdout).toContain('ya lo tenías');
  });

  it('busca sin tildes y responde "No lo tengo" cuando no está', async () => {
    await dm(['capture', '--text', 'el mecánico de Ñuñoa']);

    const hit = await dm(['--json', 'search', 'mecanico']);
    expect(hit.code).toBe(0);
    expect(hit.json).toHaveLength(1);

    const miss = await dm(['--json', 'search', 'helicoptero']);
    expect(miss.code).toBe(0);
    expect(miss.json).toEqual([]);

    const missHuman = await dm(['search', 'helicoptero']);
    expect(missHuman.stdout.trim()).toBe('No lo tengo.');
  });

  it('open devuelve los bytes originales, idénticos', async () => {
    const captured = await dm(['--json', 'capture', 'fixtures/poliza.pdf']);
    const out = join(tmpdir(), `dm-e2e-${process.pid}.pdf`);
    try {
      const opened = await dm(['--json', 'open', shortIdOf(captured), '-o', out]);
      expect(opened.code).toBe(0);
      expect(Buffer.compare(await readFile(out), await readFile('fixtures/poliza.pdf'))).toBe(0);
    } finally {
      await rm(out, { force: true });
    }
  });

  it('hide saca de los resultados sin destruir; unhide la trae de vuelta', async () => {
    const c = await dm(['--json', 'capture', '--text', 'clave del router']);
    const id = shortIdOf(c);

    expect((await dm(['--json', 'hide', id])).code).toBe(0);
    expect((await dm(['--json', 'ls'])).json).toHaveLength(0);
    expect((await dm(['--json', 'ls', '--hidden'])).json).toHaveLength(1);
    expect((await dm(['--json', 'show', id])).json.hidden).toBe(true);

    await dm(['--json', 'unhide', id]);
    expect((await dm(['--json', 'ls'])).json).toHaveLength(1);
  });
});

describe('códigos de salida', () => {
  it('purge sin --yes sale 2 y no borra nada', async () => {
    const c = await dm(['--json', 'capture', '--text', 'algo', '--title', 'La póliza']);
    const id = shortIdOf(c);

    const attempt = await dm(['--json', 'purge', id]);
    expect(attempt.code).toBe(2);
    expect(attempt.json.error.kind).toBe('requires_confirmation');
    expect(attempt.json.error.affects[0].label).toBe('La póliza');
    expect((await dm(['--json', 'ls'])).json).toHaveLength(1);

    const human = await dm(['purge', id]);
    expect(human.stderr).toContain('--yes');
  });

  it('purge --yes sale 0 y la memoria desaparece', async () => {
    const c = await dm(['--json', 'capture', 'fixtures/poliza.pdf']);
    const id = shortIdOf(c);

    const done = await dm(['--json', 'purge', id, '--yes']);
    expect(done.code).toBe(0);
    expect(done.json.blobDeleted).toBe(true);
    expect((await dm(['--json', 'ls'])).json).toEqual([]);
    expect((await dm(['--json', 'show', id])).code).toBe(3);
  });

  it('un id inexistente sale 3', async () => {
    const r = await dm(['--json', 'show', 'deadbeef']);
    expect(r.code).toBe(3);
    expect(r.json.error.kind).toBe('not_found');
  });

  it('un prefijo ambiguo sale 5 y lista los candidatos', async () => {
    const owner = (await db.query<{ id: string }>('select id from owners limit 1')).rows[0]!.id;
    for (const id of ['abcd1234-0000-4000-8000-000000000001', 'abcd1234-0000-4000-8000-000000000002']) {
      await db.query(
        `insert into memories (id, owner_id, source, normalized_text) values ($1, $2, 'cli', 'nota')`,
        [id, owner],
      );
    }
    const r = await dm(['--json', 'show', 'abcd1234']);
    expect(r.code).toBe(5);
    expect(r.json.error.detail.matches).toHaveLength(2);
  });

  it('una entrada inválida sale 1 y dice qué está mal', async () => {
    const bad = await dm(['--json', 'capture', '--text', 'x', '--occurred', 'ayer po']);
    expect(bad.code).toBe(1);
    expect(bad.json.error.message).toContain('ayer po');

    const empty = await dm(['--json', 'capture']);
    expect(empty.code).toBe(1);
    expect(empty.json.error.kind).toBe('invalid');

    const missing = await dm(['--json', 'capture', 'no-existe.pdf']);
    expect(missing.code).toBe(3);
  });
});
