import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, mintPairingCode } from '../../src/core/index';
import { createRouter } from '../../src/adapters/api/http';
import { routes } from '../../src/adapters/api/routes';
import { startStack, type TestStack } from '../helpers/stack';

let s: TestStack;
let server: Server;
let base: string;

const mine = () => ({ ownerId: s.ownerId });
const theirs = () => ({ ownerId: s.otherOwnerId });

interface Res { status: number; body: any; cookie: string | null }

async function call(
  method: string, path: string,
  opts: { cookie?: string | null; body?: unknown } = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const raw = res.headers.get('set-cookie');
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    cookie: raw ? raw.split(';')[0]! : null,
  };
}

/** Abre una sesión como lo haría el navegador: código → cookie. */
async function login(owner = mine()): Promise<string> {
  const code: any = await mintPairingCode(s.deps.db, owner.ownerId, s.deps.clock.now());
  const r = await call('POST', '/api/session', { body: { code: code.value.code } });
  expect(r.status).toBe(200);
  return r.cookie!;
}

beforeAll(async () => {
  s = await startStack();
  server = createServer(createRouter(routes, s.deps));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
beforeEach(async () => { await s.reset(); });
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await s.close();
});

describe('sin sesión no hay nada', () => {
  it('toda ruta de datos responde 401', async () => {
    for (const [m, p] of [['GET', '/api/memories'], ['GET', '/api/domains'],
                          ['GET', '/api/facts'], ['GET', '/api/overview']] as const) {
      expect((await call(m, p)).status).toBe(401);
    }
  });

  it('preguntar si hay sesión sí se puede, y dice que no', async () => {
    // Sin esto la página no distingue "deslogueado" de "servidor roto".
    const r = await call('GET', '/api/session');
    expect(r.status).toBe(200);
    expect(r.body.data.authenticated).toBe(false);
  });

  it('una cookie inventada no sirve', async () => {
    const r = await call('GET', '/api/memories', { cookie: 'dm_session=loquesea' });
    expect(r.status).toBe(401);
  });

  it('una ruta que no existe es 404 y no filtra nada', async () => {
    expect((await call('GET', '/api/loquesea')).status).toBe(404);
  });
});

describe('el código de emparejamiento abre la sesión', () => {
  it('canjea el código por una cookie httpOnly', async () => {
    const code: any = await mintPairingCode(s.deps.db, s.ownerId, s.deps.clock.now());
    const r = await call('POST', '/api/session', { body: { code: code.value.code } });

    expect(r.status).toBe(200);
    expect(r.body.data.ownerId).toBe(s.ownerId);
    expect(r.cookie).toMatch(/^dm_session=/);
  });

  it('el mismo código no sirve dos veces', async () => {
    const code: any = await mintPairingCode(s.deps.db, s.ownerId, s.deps.clock.now());
    await call('POST', '/api/session', { body: { code: code.value.code } });
    const again = await call('POST', '/api/session', { body: { code: code.value.code } });
    expect(again.status).toBe(404);
  });

  it('un código inventado no dice si existía', async () => {
    const r = await call('POST', '/api/session', { body: { code: 'ZZZZZZZZ' } });
    expect(r.status).toBe(404);
    expect(r.body.error.message).not.toMatch(/expir|usado/i);
  });

  it('el token no viaja en el cuerpo, solo en la cookie', async () => {
    const code: any = await mintPairingCode(s.deps.db, s.ownerId, s.deps.clock.now());
    const r = await call('POST', '/api/session', { body: { code: code.value.code } });
    expect(JSON.stringify(r.body)).not.toContain(r.cookie!.split('=')[1]);
  });
});

describe('el dueño sale de la sesión y de ningún parámetro', () => {
  it('no se ve lo del otro dueño', async () => {
    await capture(s.deps, mine(), { text: 'mío', title: 'Mía' });
    await capture(s.deps, theirs(), { text: 'ajeno', title: 'Ajena' });

    const r = await call('GET', '/api/memories', { cookie: await login() });
    expect(r.body.data.map((m: any) => m.title)).toEqual(['Mía']);
  });

  it('pedir la memoria de otro dueño por id es 404, no 403', async () => {
    // 403 confirmaría que existe. 404 no dice nada.
    const otra: any = await capture(s.deps, theirs(), { text: 'ajeno' });
    const r = await call('GET', `/api/memories/${otra.value.id}`, { cookie: await login() });
    expect(r.status).toBe(404);
  });

  it('no hay forma de pedir otro dueño por parámetro', async () => {
    await capture(s.deps, theirs(), { text: 'ajeno', title: 'Ajena' });
    const cookie = await login();
    for (const q of [`?owner=${s.otherOwnerId}`, `?ownerId=${s.otherOwnerId}`, `?actor=${s.otherOwnerId}`]) {
      const r = await call('GET', `/api/memories${q}`, { cookie });
      expect(r.body.data).toEqual([]);
    }
  });
});

describe('las confirmaciones viajan como 409 con lo afectado', () => {
  it('purgar sin confirmar no borra y nombra lo que se llevaría', async () => {
    const m: any = await capture(s.deps, mine(), { text: 'algo', title: 'La póliza' });
    const cookie = await login();

    const r = await call('DELETE', `/api/memories/${m.value.id}`, { cookie });
    expect(r.status).toBe(409);
    expect(r.body.error.kind).toBe('requires_confirmation');
    expect(r.body.error.affects[0].label).toBe('La póliza');

    expect((await call('GET', '/api/memories', { cookie })).body.data).toHaveLength(1);
  });

  it('con confirm=true sí borra', async () => {
    const m: any = await capture(s.deps, mine(), { text: 'algo' });
    const cookie = await login();
    expect((await call('DELETE', `/api/memories/${m.value.id}?confirm=true`, { cookie })).status).toBe(200);
    expect((await call('GET', '/api/memories', { cookie })).body.data).toHaveLength(0);
  });
});

describe('curar corrige el juicio del clasificador', () => {
  it('cambia dominio, título y fecha del hecho', async () => {
    const m: any = await capture(s.deps, mine(), { text: 'una póliza' });
    const cookie = await login();

    const r = await call('PATCH', `/api/memories/${m.value.id}`, {
      cookie, body: { domain: 'seguros', title: 'Póliza 2026', occurredAt: '2026-07-29' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.changed).toEqual(['domain', 'title', 'occurredAt']);

    const d = await call('GET', `/api/memories/${m.value.id}`, { cookie });
    expect(d.body.data.memory.title).toBe('Póliza 2026');
    // El core expone la etiqueta del dominio, no su slug, en el detalle.
    expect(d.body.data.memory.domainLabel).toBe('Seguros');
  });

  it('una fecha mal escrita se rechaza antes de tocar la fila', async () => {
    const m: any = await capture(s.deps, mine(), { text: 'x' });
    const r = await call('PATCH', `/api/memories/${m.value.id}`, {
      cookie: await login(), body: { occurredAt: '29/07/2026' },
    });
    expect(r.status).toBe(400);
  });

  it('una categoría de otro dueño no existe para mí', async () => {
    const m: any = await capture(s.deps, mine(), { text: 'x' });
    const r = await call('PATCH', `/api/memories/${m.value.id}`, {
      cookie: await login(), body: { domain: 'no-existe' },
    });
    expect(r.status).toBe(404);
  });
});

describe('no hay por dónde capturar', () => {
  it('ninguna ruta acepta subir un archivo', async () => {
    // §2: capturar es solo chat, y su ausencia acá es el diseño.
    for (const p of ['/api/memories', '/api/capture', '/api/upload']) {
      const r = await call('POST', p, { cookie: await login(), body: { text: 'x' } });
      expect([404, 405]).toContain(r.status);
    }
  });
});
