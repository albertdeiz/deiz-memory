import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPairingCode } from '../../src/core/index.js';
import type { Reply } from '../../src/core/channel/types.js';
import { fakeChannel, fileAttachment, oversizedAttachment, type FakeChannel } from '../../src/adapters/chat/fake.js';
import { serveChannel } from '../../src/adapters/chat/serve.js';
import { fakeConverter, fakeConverters } from '../helpers/converters.js';
import { startStack, type TestStack } from '../helpers/stack.js';

/**
 * El canal de punta a punta, contra Postgres y Garage reales. Lo que se prueba
 * son conversaciones completas: parear, mandar, buscar, paginar — y sobre todo
 * lo que NO debe pasar.
 */
let s: TestStack;
let ch: FakeChannel;

const text = (rs: Reply[]): string =>
  rs.map((r) => (r.kind === 'text' ? r.body : `[archivo ${r.filename}]`)).join('\n');

const LARGO = 'Boleta 88213 · Amoladora Bosch · $89.990 · 14/03/2026 · Ferretería El Roble. '.repeat(3);

beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s.close(); });

beforeEach(async () => {
  await s.reset();
  s.deps.converters = fakeConverters();
  ch = fakeChannel();
  await serveChannel(ch, s.deps);
});

const pairMe = async (channel = ch, ownerId = s.ownerId) => {
  const c = await mintPairingCode(s.deps.db, ownerId, new Date());
  if (!c.ok) throw new Error('no acuñó');
  return channel.send({ text: `/empezar ${c.value.code}` });
};

describe('quién puede hablarle', () => {
  it('un desconocido recibe una línea y nada se guarda', async () => {
    const out = await ch.send({ text: 'guárdame esto' });
    expect(text(out)).toBe('No te conozco.');

    // No se guarda contenido de un extraño, ni siquiera para revisarlo después.
    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from memories');
    expect(rows[0]!.n).toBe('0');
  });

  it('se calla si el desconocido insiste, en vez de hacer eco', async () => {
    const at = new Date('2026-03-14T12:00:00Z');
    expect(text(await ch.send({ text: 'hola', at }))).toBe('No te conozco.');
    const otra = new Date(at.getTime() + 30_000);
    expect(await ch.send({ text: 'hola?', at: otra })).toHaveLength(0);
  });

  it('con un código válido queda adentro', async () => {
    expect(text(await pairMe())).toContain('Listo');
    expect(text(await ch.send({ text: 'el gasfiter es Rodrigo' }))).toContain('Guardado');
  });

  it('un código inventado no abre la puerta', async () => {
    expect(text(await ch.send({ text: '/empezar ZZZZZZZZ' }))).toContain('no sirve');
    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from channel_identities');
    expect(rows[0]!.n).toBe('0');
  });
});

describe('capturar', () => {
  beforeEach(async () => { await pairMe(); });

  it('guarda un texto suelto y no promete leerlo', async () => {
    // Un texto ya es texto: no hay nada que un carril pueda agregarle.
    const out = text(await ch.send({ text: 'el mecánico es Juan +569 1234 5678' }));
    expect(out).toContain('Guardado');
    expect(out).not.toContain('Lo estoy leyendo');
  });

  it('guarda una foto y avisa que la está leyendo', async () => {
    // El acuse dice el estado, no solo "éxito": la espera queda declarada.
    s.deps.converters = fakeConverters({ vision: fakeConverter(LARGO) });
    const out = text(await ch.send({
      text: 'la boleta del taller',
      attachment: await fileAttachment('fixtures/f1/boleta-escaneada.png'),
    }));
    expect(out).toContain('Guardado');
    expect(out).toContain('Lo estoy leyendo');
  });

  it('rechaza lo que no cabe por el canal, y no crea la memoria', async () => {
    // El tamaño se compara ANTES de bajar: el fetch de este adjunto revienta si
    // alguien lo llama, y que el test pase prueba que nadie lo llamó.
    const out = text(await ch.send({ attachment: oversizedAttachment(50 * 1024 * 1024) }));
    expect(out).toContain('50 MB');
    expect(out).toContain('dm capture');

    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from memories');
    expect(rows[0]!.n).toBe('0');
  });
});

describe('recordar', () => {
  beforeEach(async () => { await pairMe(); });

  const guardar = async (n: number) => {
    for (let i = 1; i <= n; i++) {
      await ch.send({ text: `póliza número ${i} del vehículo` });
    }
  };

  it('encuentra lo guardado y numera los resultados', async () => {
    await guardar(3);
    const out = text(await ch.send({ text: '/buscar poliza' }));
    expect(out).toContain('1–3');
    expect(out).toMatch(/1\. /);
  });

  it('pagina de a cinco, como manda §6.1', async () => {
    await guardar(8);
    const p1 = text(await ch.send({ text: '/buscar poliza' }));
    expect(p1).toContain('1–5');

    const p2 = text(await ch.send({ text: 'más' }));
    expect(p2).toContain('6–8');
  });

  it('pedir más al final dice que no hay más, no que no lo tiene', async () => {
    // Son cosas distintas: una es el final de una lista, la otra una respuesta
    // sobre tu memoria.
    await guardar(2);
    await ch.send({ text: '/buscar poliza' });
    expect(text(await ch.send({ text: 'más' }))).toBe('No hay más.');
  });

  it('un número suelto abre el resultado de esa posición', async () => {
    await guardar(3);
    await ch.send({ text: '/buscar poliza' });
    const detalle = text(await ch.send({ text: '2' }));
    expect(detalle).toContain('póliza número');
  });

  it('un número suelto sin lista en pantalla se guarda, no se interpreta', async () => {
    // §5: perder un dato es lo caro.
    const out = text(await ch.send({ text: '7' }));
    expect(out).toContain('Guardado');
  });

  it('ofrece guardar una pregunta que no encontró nada', async () => {
    const out = text(await ch.send({ text: '¿dónde está la garantía del refrigerador?' }));
    expect(out).toContain('No lo tengo');
    expect(out).toContain('guardar');

    expect(text(await ch.send({ text: 'guardar' }))).toContain('Guardado');
  });

  it('no ofrece guardar lo que buscaste a propósito', async () => {
    // Si escribiste /buscar querías buscar. Ofrecerte guardar "pinguino" como
    // nota sería guardarte un texto que nunca quisiste guardar.
    const out = text(await ch.send({ text: '/buscar pinguino' }));
    expect(out).toContain('No lo tengo');
    expect(out).not.toContain('guardar');
  });

  it('dice cuánto falta por leer, para no mentir con un "no lo tengo"', async () => {
    // Una búsqueda que responde "no lo tengo" mientras un OCR corre está
    // mintiendo. Es la métrica estrella de §15.
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:todavía no') });
    await ch.send({ attachment: await fileAttachment('fixtures/f1/boleta-escaneada.png') });
    await s.deps.db.query(`update memories set normalized_at = null where blob_sha256 is not null`);

    const out = text(await ch.send({ text: '/buscar amoladora' }));
    expect(out).toContain('No lo tengo');
    expect(out).toMatch(/por leer/);
  });
});

describe('aislamiento entre personas (regla dura 9)', () => {
  it('otra identidad no ve tus memorias', async () => {
    await pairMe();
    await ch.send({ text: 'mi póliza secreta del auto' });

    // Otra persona, pareada a otro dueño, sobre el mismo canal.
    const otro = fakeChannel({ externalUserId: 'intruso', chatId: 'chat-2' });
    await serveChannel(otro, s.deps);
    await pairMe(otro, s.otherOwnerId);

    const out = text(await otro.send({ text: '/buscar poliza' }));
    expect(out).toContain('No lo tengo');
    expect(out).not.toContain('secreta');
  });
});

describe('el turno se cierra', () => {
  it('no se puede responder después de que el handler retorna', async () => {
    // §2 sostenida por el tipo: sin un send() suelto, el bot no tiene cómo
    // iniciar conversación. El canal falso lo comprueba de verdad.
    await pairMe();
    let escaped: ((r: Reply) => Promise<void>) | null = null;
    const espia = fakeChannel({ chatId: 'chat-espia' });
    await espia.listen(async (turn) => {
      escaped = turn.reply.bind(turn);
      await turn.reply({ kind: 'text', body: 'dentro del turno, bien' });
    });
    await espia.send({ text: 'hola' });

    await expect(escaped!({ kind: 'text', body: 'fuera del turno' })).rejects.toThrow(/turno ya se cerró/);
  });
});
