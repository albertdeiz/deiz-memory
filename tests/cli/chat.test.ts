import { execFile } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, pgDb } from '../../src/adapters/db/postgres/index';
import { runMigrations } from '../../src/adapters/db/postgres/migrate';
import { ensureTestDatabase, TEST_DATABASE_URL, TEST_ENV } from '../helpers/env';

const BIN = 'dist/dm.js';

const dm = (args: string[]): Promise<{ code: number; out: string; json: any }> =>
  new Promise((resolve) => {
    execFile('node', [BIN, ...args], { env: TEST_ENV, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      let json: any;
      for (const s of [stdout, stderr]) { try { json = JSON.parse(s); break; } catch { /* sigue */ } }
      resolve({ code: (error as { code?: number } | null)?.code ?? 0, out: stdout + stderr, json });
    });
  });

const pool = createPool(TEST_DATABASE_URL);
const db = pgDb(pool);

beforeAll(async () => { await ensureTestDatabase(); await runMigrations(db); }, 60_000);
beforeEach(async () => {
  await db.query(
    'truncate memories, memory_chunks, blobs, audit_log, channel_identities, pairing_codes, chat_sessions, domains, owners restart identity cascade',
  );
  expect((await dm(['--json', 'init', 'yo'])).code).toBe(0);
});
afterAll(async () => { await pool.end(); });

const pair = async () => {
  const p = await dm(['--json', 'pair']);
  expect(p.code).toBe(0);
  return dm(['chat', `/start ${p.json.code}`]);
};

/**
 * `dm chat` habla por un canal que declara `supportsButtons: false`, así que
 * cada corrida de estos tests ejercita la rama degradada de §7.1 de punta a
 * punta. Es el pago concreto de haber construido el canal falso antes que el
 * de verdad: la promesa de "no horneamos las asunciones de un canal" se
 * comprueba sola.
 */
describe('conversación completa por CLI', () => {
  it('un desconocido no entra, y no deja rastro', async () => {
    const r = await dm(['chat', 'hola']);
    expect(r.out).toContain('No te conozco');

    const { rows } = await db.query<{ n: string }>('select count(*)::text n from memories');
    expect(rows[0]!.n).toBe('0');
  }, 60_000);

  it('parear, guardar y encontrar', async () => {
    expect((await pair()).out).toContain('Listo');

    expect((await dm(['chat', '/capture el mecánico es Juan Pérez de Ñuñoa'])).out).toContain('Guardado');

    // Sin tildes, como escribe la gente en un teléfono.
    const buscado = await dm(['chat', '/search mecanico']);
    expect(buscado.out).toContain('1–1');
    expect(buscado.out).toContain('Juan');
  }, 90_000);

  it('sin botones, el bot dice qué escribir y la palabra funciona', async () => {
    await pair();
    for (let i = 1; i <= 7; i++) await dm(['chat', `/capture póliza ${i} del vehículo`]);

    const p1 = await dm(['chat', '/search poliza']);
    expect(p1.out).toContain('1–5');
    // La lista numerada aparece porque el canal no tiene botones.
    expect(p1.out).toContain('more');

    const p2 = await dm(['chat', 'more']);
    expect(p2.out).toContain('6–7');
  }, 120_000);

  it('un archivo se guarda y el acuse dice que lo está leyendo', async () => {
    await pair();
    const r = await dm(['chat', '--file', 'fixtures/f1/poliza-texto.pdf', 'la póliza nueva']);
    expect(r.out).toContain('Guardado');
    expect(r.out).toContain('Lo estoy leyendo');
  }, 90_000);

  it('otra identidad no ve lo tuyo', async () => {
    await pair();
    await dm(['chat', '/capture mi póliza secreta']);

    // Otro id de canal, sin parear: ni siquiera llega a buscar.
    const intruso = await dm(['chat', '--as', 'intruso', '/search poliza']);
    expect(intruso.out).toContain('No te conozco');
    expect(intruso.out).not.toContain('secreta');
  }, 90_000);
});
