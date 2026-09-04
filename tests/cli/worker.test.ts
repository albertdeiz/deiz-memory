import { execFile, spawn } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index';
import { runMigrations } from '../../src/adapters/db/postgres/migrate';
import { ensureTestDatabase, TEST_DATABASE_URL, TEST_ENV } from '../helpers/env';

const BIN = 'dist/dm.js';
// Tu mismo stack, pero con la base y el bucket de pruebas: el binario recibe
// las variables por entorno en vez de leer un .env propio.
const ENV = TEST_ENV;

interface Run { code: number; stdout: string; stderr: string; json: any }

const dm = (args: string[]): Promise<Run> =>
  new Promise((resolve) => {
    execFile('node', [BIN, ...args], { env: ENV, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      let json: any;
      for (const stream of [stdout, stderr]) {
        try { json = JSON.parse(stream); break; } catch { /* sigue */ }
      }
      resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr, json });
    });
  });

/**
 * Levanta el worker de verdad y espera a que diga que terminó un trabajo. Es la
 * única forma de probar que la cola está enchufada: si `capture` encolara al
 * vacío, todos los demás tests seguirían pasando y nadie se enteraría.
 */
const workUntil = (needle: string, timeoutMs = 45_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('node', [BIN, 'worker'], { env: ENV });
    let out = '';
    let settle: (() => void) | null = null;

    // Se espera a que el worker MUERA de verdad, no solo a mandarle la señal.
    // Un worker sobreviviente sigue sacando trabajos de la cola durante el test
    // siguiente, y el test siguiente afirma que nadie los ha tocado. Es el tipo
    // de flakiness que después se pasa media hora buscando en el lugar
    // equivocado.
    child.on('exit', () => settle?.());

    const done = (fn: () => void) => {
      clearTimeout(timer);
      settle = fn;
      child.kill('SIGINT');
      // Si no se muere solo en 10s, se lo mata en serio.
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`el worker no procesó nada en ${timeoutMs}ms:\n${out}`))),
      timeoutMs,
    );
    const onData = (b: Buffer) => {
      out += b.toString();
      if (out.includes(needle)) done(() => resolve(out));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => done(() => reject(e)));
  });

const pool = createPool(TEST_DATABASE_URL);
const db = pgDb(pool);

beforeAll(async () => { await ensureTestDatabase(); await runMigrations(db); }, 60_000);
beforeEach(async () => {
  await db.query('truncate memories, memory_chunks, blobs, audit_log, channel_identities, pairing_codes, chat_sessions, domains, owners restart identity cascade');
  // La cola sobrevive al truncate de las memorias: sin esto, un trabajo viejo
  // apuntaría a una memoria que ya no existe y el worker gritaría por nada.
  await db.query('delete from pgboss.job').catch(() => {});
  expect((await dm(['--json', 'init', 'yo'])).code).toBe(0);
});
afterAll(async () => { await pool.end(); });

describe('la cola', () => {
  it('capture vuelve enseguida y deja el trabajo encolado', async () => {
    // El contrato de §7: "guardado" significa guardado, no "terminado de analizar".
    const cap = await dm(['--json', 'capture', 'fixtures/f1/poliza-texto.pdf']);
    expect(cap.code).toBe(0);
    const id = cap.json.shortId;

    const antes = await dm(['--json', 'show', id]);
    expect(antes.json.normalizedAt).toBeNull();
    expect(antes.json.lane).toBeNull();
    // Todavía no es buscable por dentro, y eso es correcto: nadie lo ha leído.
    expect((await dm(['--json', 'search', '4471-2026'])).json).toHaveLength(0);
  }, 60_000);

  it('el worker toma el trabajo y lo deja buscable por su contenido', async () => {
    const cap = await dm(['--json', 'capture', 'fixtures/f1/poliza-texto.pdf']);
    const id = cap.json.shortId;

    await workUntil(id, 180_000);

    const despues = await dm(['--json', 'show', id]);
    expect(despues.json.lane).toBe('document');
    expect(despues.json.normalizedText).toContain('4471-2026');

    // El criterio de F1, por el camino real: encontrarlo por lo que dice.
    const hit = await dm(['--json', 'search', 'deducible']);
    expect(hit.json).toHaveLength(1);
    expect(hit.json[0].shortId).toBe(id);
  }, 200_000);
});

describe('capture --wait', () => {
  it('normaliza en el acto, sin worker de por medio', async () => {
    const cap = await dm(['--json', 'capture', '--wait', 'fixtures/notas.txt']);
    expect(cap.code).toBe(0);

    const detail = await dm(['--json', 'show', cap.json.shortId]);
    expect(detail.json.lane).toBe('text');
    expect(detail.json.normalizedText).toContain('paracetamol');
  }, 60_000);
});

describe('reprocess', () => {
  it('pide confirmación en lote y sale 2', async () => {
    await dm(['--json', 'capture', '--wait', 'fixtures/notas.txt']);
    await dm(['--json', 'capture', '--wait', 'fixtures/f1/poliza-texto.pdf']);

    const sin = await dm(['--json', 'reprocess', '--all']);
    expect(sin.code).toBe(2);
    expect(sin.json.error.kind).toBe('requires_confirmation');
  }, 120_000);

  it('exige decir qué reprocesar', async () => {
    const res = await dm(['--json', 'reprocess']);
    expect(res.code).toBe(1);
    expect(res.json.error.kind).toBe('invalid');
  }, 60_000);

  it('rechaza un carril que no existe', async () => {
    const res = await dm(['--json', 'reprocess', '--lane', 'telepatia']);
    expect(res.code).toBe(1);
    expect(res.json.error.message).toContain('Carril inválido');
  }, 60_000);

  it('vuelve a leer el original con --wait', async () => {
    const cap = await dm(['--json', 'capture', '--wait', 'fixtures/notas.txt']);
    const id = cap.json.shortId;

    const again = await dm(['--json', 'reprocess', '--wait', id]);
    expect(again.code).toBe(0);
    expect(again.json.queued).toBe(1);

    const detail = await dm(['--json', 'show', id]);
    expect(detail.json.normalizedText).toContain('paracetamol');
  }, 120_000);
});
