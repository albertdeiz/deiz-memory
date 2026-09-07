import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPairingCode } from '../../src/core/index';
import type { Reply } from '../../src/core/channel/types';
import { fakeChannel, fileAttachment, oversizedAttachment, type FakeChannel } from '../../src/adapters/chat/fake';
import { serveChannel } from '../../src/adapters/chat/serve';
import { fakeConverter, fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * The channel end to end, against the real database and object store. What is
 * tested is whole conversations: pair, send, search, page — and above all what
 * must NOT happen.
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
  return channel.send({ text: `/start ${c.value.code}` });
};

describe('quién puede hablarle', () => {
  it('un desconocido recibe una línea y nada se guarda', async () => {
    const out = await ch.send({ text: 'guárdame esto' });
    expect(text(out)).toBe('No te conozco.');

    // A stranger's content is not stored, not even for later review.
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
    expect(text(await ch.send({ text: '/capture el gasfiter es Rodrigo' }))).toContain('Guardado');
  });

  it('un código inventado no abre la puerta', async () => {
    expect(text(await ch.send({ text: '/start ZZZZZZZZ' }))).toContain('no sirve');
    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from channel_identities');
    expect(rows[0]!.n).toBe('0');
  });
});

describe('capture', () => {
  beforeEach(async () => { await pairMe(); });

  it('guarda un texto suelto con /capture, y no promete leerlo', async () => {
    // Text is already text: there is nothing a lane can add to it.
    const out = text(await ch.send({ text: '/capture el mecánico es Juan +569 1234 5678' }));
    expect(out).toContain('Guardado');
    expect(out).not.toContain('Lo estoy leyendo');
  });

  it('un texto SIN /capture no se guarda: se query', async () => {
    // In a chat, what you type is almost always something you are asking.
    // Guardar por defecto dejaba preguntas convertidas en memorias.
    const out = text(await ch.send({ text: 'el mecánico es Juan +569 1234 5678' }));
    expect(out).not.toContain('Guardado');
    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from memories');
    expect(rows[0]!.n).toBe('0');
  });

  it('guarda una foto y avisa que la está leyendo', async () => {
    // The acknowledgement states the status, not just success: the wait is declared.
    s.deps.converters = fakeConverters({ vision: fakeConverter(LARGO) });
    const out = text(await ch.send({
      text: 'la boleta del taller',
      attachment: await fileAttachment('fixtures/f1/boleta-escaneada.png'),
    }));
    expect(out).toContain('Guardado');
    expect(out).toContain('Lo estoy leyendo');
  });

  it('rechaza lo que no cabe por el canal, y no crea la memoria', async () => {
    // The size is compared BEFORE downloading: this attachment's fetch throws if
    // anyone calls it, and the test passing proves nobody did.
    const out = text(await ch.send({ attachment: oversizedAttachment(50 * 1024 * 1024) }));
    expect(out).toContain('50 MB');
    expect(out).toContain('dm capture');

    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from memories');
    expect(rows[0]!.n).toBe('0');
  });
});

describe('recall', () => {
  beforeEach(async () => { await pairMe(); });

  const guardar = async (n: number) => {
    for (let i = 1; i <= n; i++) {
      await ch.send({ text: `/capture póliza número ${i} del vehículo` });
    }
  };

  it('encuentra lo guardado y numera los resultados', async () => {
    await guardar(3);
    const out = text(await ch.send({ text: '/search poliza' }));
    expect(out).toContain('1–3');
    expect(out).toMatch(/1\. /);
  });

  it('pagina de a cinco, como manda §6.1', async () => {
    await guardar(8);
    const p1 = text(await ch.send({ text: '/search poliza' }));
    expect(p1).toContain('1–5');

    const p2 = text(await ch.send({ text: 'more' }));
    expect(p2).toContain('6–8');
  });

  it('pedir más al final dice que no hay más, no que no lo tiene', async () => {
    // Different things: one is the end of a list, the other an answer about your
    // sobre tu memoria.
    await guardar(2);
    await ch.send({ text: '/search poliza' });
    expect(text(await ch.send({ text: 'more' }))).toBe('No hay más.');
  });

  it('un número suelto abre el resultado de esa posición', async () => {
    await guardar(3);
    await ch.send({ text: '/search poliza' });
    const detalle = text(await ch.send({ text: '2' }));
    expect(detalle).toContain('póliza número');
  });

  it('un número suelto sin lista en pantalla no es "ver el séptimo"', async () => {
    // With no list, a 7 cannot mean a position. It is queried, and if there is
    // nothing it is offered for saving: nothing is lost.
    const out = text(await ch.send({ text: '7' }));
    expect(out).toContain('No lo tengo');
    expect(text(await ch.send({ text: 'save' }))).toContain('Guardado');
  });

  it('ofrece guardar una pregunta que no encontró nada', async () => {
    const out = text(await ch.send({ text: '¿dónde está la garantía del refrigerador?' }));
    expect(out).toContain('No lo tengo');
    expect(out).toContain('save');

    expect(text(await ch.send({ text: 'save' }))).toContain('Guardado');
  });

  it('no ofrece guardar lo que buscaste a propósito', async () => {
    // An explicit search meant search. Offering to store the search term as a note
    // would store text you never meant to store.
    const out = text(await ch.send({ text: '/search pinguino' }));
    expect(out).toContain('No lo tengo');
    expect(out).not.toContain('save');
  });

  it('dice cuánto falta por leer, para no mentir con un "no lo tengo"', async () => {
    // A search answering "I do not have it" while an OCR pass runs is lying. That
    // rate is the metric that matters.
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:todavía no') });
    await ch.send({ attachment: await fileAttachment('fixtures/f1/boleta-escaneada.png') });
    await s.deps.db.query(`update memories set normalized_at = null where blob_sha256 is not null`);

    const out = text(await ch.send({ text: '/search amoladora' }));
    expect(out).toContain('No lo tengo');
    expect(out).toMatch(/por leer/);
  });
});

describe('aislamiento entre personas (regla dura 9)', () => {
  it('otra identidad no ve tus memorias', async () => {
    await pairMe();
    await ch.send({ text: 'mi póliza secreta del auto' });

    // Another person, paired to another owner, over the same channel.
    const otro = fakeChannel({ externalUserId: 'intruso', chatId: 'chat-2' });
    await serveChannel(otro, s.deps);
    await pairMe(otro, s.otherOwnerId);

    const out = text(await otro.send({ text: '/search poliza' }));
    expect(out).toContain('No lo tengo');
    expect(out).not.toContain('secreta');
  });
});

describe('el turno se cierra', () => {
  it('no se puede responder después de que el handler retorna', async () => {
    // Held up by the type: with no loose send, the bot has no way to start a
    // conversation. The fake channel actually verifies it.
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

describe('paridad con el CLI', () => {
  beforeEach(async () => { await pairMe(); });

  it('una pregunta se responde con cita; una búsqueda se lista', async () => {
    // The distinction the chat used to miss: asking brought five documents to look
    // through, instead of the datum.
    s.deps.classifier = {
      async classify() { return {}; },
      async complete() { return 'El deducible es de 5 UF [1].'; },
      async available() { return { ok: true, detail: 'fake' }; },
    };
    // With no embedder retrieval degrades to full-text, which suffices here: what is
    // tested is that asking answers, not the quality of the vector.
    s.deps.embedder = null;
    await ch.send({ text: '/capture el deducible de la póliza es de 5 UF por siniestro' });

    const preg = text(await ch.send({ text: '¿cuál es el deducible?' }));
    expect(preg).toContain('5 UF');
    expect(preg).toMatch(/\[[0-9a-f]{8}\]/);

    const busq = text(await ch.send({ text: '/search deducible' }));
    expect(busq).toContain('1–1');
  });

  it('se puede ocultar un resultado sin poder borrarlo', async () => {
    // The chat hides; purging is irreversible and stays in the terminal.
    await ch.send({ text: '/capture la póliza del auto' });
    await ch.send({ text: '/search poliza' });
    expect(text(await ch.send({ text: 'hide:1' }))).toContain('No se borró');
    expect(text(await ch.send({ text: '/search poliza' }))).toContain('No lo tengo');

    // Sigue existiendo: ocultar es un flag, no un borrado.
    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from memories');
    expect(rows[0]!.n).toBe('1');
  });

  it('un comando que no existe orienta hacia los dos caminos', async () => {
    const out = text(await ch.send({ text: '/pinguinos' }));
    expect(out).toContain('/domains');
    expect(out).toContain('/help');
  });

  it('no ofrece exportar, que no existe', async () => {
    // Promising a command that does nothing is worse than not having it.
    expect(text(await ch.send({ text: '/ayuda' }))).not.toContain('exportar');
  });
});

describe('categorías desde el chat (§9)', () => {
  beforeEach(async () => { await pairMe(); });

  it('crea una categoría y la deja usable de inmediato', async () => {
    const out = text(await ch.send({ text: '/create Migración: Visas, RUT y permanencia definitiva' }));
    expect(out).toContain('/migracion');
    expect(text(await ch.send({ text: '/migracion' }))).toContain('Migración');
  });

  it('exige descripción, porque la descripción es el prompt', async () => {
    expect(text(await ch.send({ text: '/create Varios' }))).toContain('descripción');
  });

  it('pide confirmación si se solapa, y respeta el no', async () => {
    await ch.send({ text: '/create Consultorio: Consultas médicas y recetas del doctor' });
    const aviso = text(await ch.send({ text: '/create Medico: Consultas médicas y recetas clínicas' }));
    expect(aviso).toContain('se parece');

    expect(text(await ch.send({ text: 'no' }))).toContain('no hago nada');
    expect(text(await ch.send({ text: '/domains' }))).not.toContain('/medico');
  });

  it('y crea igual si dices que sí', async () => {
    await ch.send({ text: '/create Consultorio: Consultas médicas y recetas del doctor' });
    await ch.send({ text: '/create Medico: Consultas médicas y recetas clínicas' });
    expect(text(await ch.send({ text: 'yes' }))).toContain('/medico');
  });

  it('renombrar no cambia el slug: la identidad es el id', async () => {
    // A description that does not overlap the seed, or the overlap guard would ask
    // for confirmation and there would be nothing to rename.
    await ch.send({ text: '/create Bitácora: Anotaciones sueltas del día a día' });
    expect(text(await ch.send({ text: '/rename bitacora Diario' }))).toContain('/bitacora');
  });

  it('fusionar mueve las memorias y pide confirmación primero', async () => {
    await ch.send({ text: '/create Papeles: Cosas sueltas de papel del escritorio' });
    await ch.send({ text: '/create Carpetas: Carpetas físicas archivadas en el mueble' });
    expect(text(await ch.send({ text: '/merge papeles carpetas' }))).toContain('archiva');
    expect(text(await ch.send({ text: 'yes' }))).toContain('archivada');
  });

  it('una confirmación vencida no vale', async () => {
    // A yes arriving half an hour late does not refer to what you think.
    const t0 = new Date('2026-03-14T12:00:00Z');
    await ch.send({ text: '/create Consultorio: Consultas médicas y recetas', at: t0 });
    await ch.send({ text: '/create Medico: Consultas médicas y recetas clínicas', at: t0 });
    const tarde = new Date(t0.getTime() + 40 * 60_000);
    expect(text(await ch.send({ text: 'yes', at: tarde }))).toContain('No hay nada esperando');
  });
});

describe('"ver 2" es el 2 de la lista que estoy mirando', () => {
  /**
   * The bug: the category listing numbered its four results and offered the view
   * buttons without ever recording those ids in the session. Pressing 2 returned
   * the second of the previous SEARCH — a real document, of something else. The
   * worst kind of silent failure, because it looks like an answer.
   */
  const guardar = async (body: string) => ch.send({ text: `/capture ${body}` });

  beforeEach(async () => {
    await pairMe();
    await s.deps.db.query(
      `insert into domains (owner_id, slug, label, description)
       values ($1,'papeles','Papeles','cédula, pasaporte, licencia')`, [s.ownerId]);
  });

  it('numerar una categoría no puede resolverse contra la lista anterior', async () => {
    // A search leaves ITS list in the session...
    await guardar('contrato de arriendo del departamento');
    await guardar('presupuesto de la mudanza');
    await ch.send({ text: '/search mudanza' });

    // ...and now a category with other things, in another order.
    for (const t of ['cédula de identidad', 'licencia de conducir', 'pasaporte vigente']) {
      const r = await guardar(t);
      const id = /([0-9a-f]{8})/.exec(text(r))?.[1];
      await s.deps.db.query(
        `update memories set domain_id = (select id from domains where owner_id=$2 and slug='papeles')
          where id::text like $1 || '%'`, [id, s.ownerId]);
    }

    const lista = text(await ch.send({ text: '/papeles' }));
    // The second of what was shown, read from the reply itself.
    const segundo = /^2\. (.+)$/m.exec(lista)?.[1]?.trim();
    expect(segundo).toBeTruthy();

    const detalle = text(await ch.send({ text: 'view:2' }));
    expect(detalle).toContain(segundo!.split('\n')[0]!);
    // And of course nothing from the earlier search.
    expect(detalle).not.toContain('mudanza');
  });

  it('una categoría vacía no deja viva la lista anterior', async () => {
    await guardar('presupuesto de la mudanza');
    await ch.send({ text: '/search mudanza' });
    await ch.send({ text: '/papeles' });
    // The category is empty, so "view 1" cannot open the earlier result.
    expect(text(await ch.send({ text: 'view:1' }))).not.toContain('mudanza');
  });

  /**
   * The other half of the same failure, and the one a session table cannot fix.
   *
   * A chat history stays on screen and stays tappable. Pressing the button of an
   * older list resolves a position against the list shown NOW — it does not
   * fail, it opens a different document. So the button carries the id and the
   * typed number stays relative, which is what §7.1 states.
   */
  it('el botón de una lista vieja sigue abriendo lo suyo', async () => {
    await guardar('contrato de arriendo del departamento');
    await guardar('presupuesto de la mudanza');

    const vieja = await ch.send({ text: '/search arriendo' });
    const boton = vieja
      .flatMap((r) => (r.kind === 'text' ? r.options ?? [] : []))
      .find((o) => o.action.startsWith('view:'));
    expect(boton).toBeDefined();
    // What travels is the id; what is typed is still the position.
    expect(boton!.action).toMatch(/^view:[0-9a-f]{8}$/);
    expect(boton!.typed).toBe('view:1');

    // Another list takes over the session, as any new listing does.
    await ch.send({ text: '/search mudanza' });

    // Scrolling up and pressing the old button: it opens what it always named.
    const detalle = text(await ch.send({ action: boton!.action }));
    expect(detalle).toContain('arriendo');
    expect(detalle).not.toContain('mudanza');

    // Typing the number, on the other hand, means the list on screen. Both are
    // right; they answer different questions.
    expect(text(await ch.send({ text: 'view:1' }))).toContain('mudanza');
  });

  it('un id escrito no necesita lista en pantalla', async () => {
    const r = await guardar('póliza de incendio del departamento');
    const id = /([0-9a-f]{8})/.exec(text(r))?.[1];
    expect(id).toBeTruthy();

    // Nothing was listed in this conversation, and it opens anyway: an id points
    // at itself. A bare number here would be someone capturing a number.
    expect(text(await ch.send({ text: `view:${id}` }))).toContain('incendio');
  });
});

describe('bajar el archivo desde la lista', () => {
  beforeEach(async () => { await pairMe(); });

  /** Un adjunto de bytes en memoria, sin tocar el disco. */
  const bytesAttachment = (filename: string, body: string) => ({
    filename,
    declaredMediaType: 'text/plain',
    sizeBytes: Buffer.byteLength(body),
    fetch: async () => Buffer.from(body),
  });

  it('el botón de archivo manda el original de ESE resultado', async () => {
    await ch.send({ text: 'contrato de arriendo' });
    await ch.send({
      text: 'la boleta de la amoladora',
      attachment: bytesAttachment('boleta.txt', LARGO),
    });

    const lista = await ch.send({ text: '/search amoladora' });
    const opciones = lista.flatMap((r) => (r.kind === 'text' ? r.options ?? [] : []));
    // The button names the memory; the typed form names the position.
    expect(opciones.map((o) => o.typed ?? o.action)).toContain('open:1');
    expect(opciones.some((o) => /^open:[0-9a-f]{8}$/.test(o.action))).toBe(true);

    const out = await ch.send({ text: 'open:1' });
    const file = out.find((r) => r.kind === 'file');
    expect(file).toBeDefined();
    if (file?.kind === 'file') expect(file.bytes.toString()).toContain('Amoladora');
  });

  it('"mandarme el original" desde el detalle no manda el de otro', async () => {
    // The button encoded position 1, so opening the second and asking for its
    // original returned the first item's file.
    for (const [name, cuerpo] of [['uno.txt', 'PRIMERO uno'], ['dos.txt', 'SEGUNDO dos']] as const) {
      await ch.send({
        text: cuerpo,
        attachment: bytesAttachment(name, `${cuerpo} `.repeat(20)),
      });
    }

    await ch.send({ text: '/search segundo' });
    await ch.send({ text: 'view:1' });
    const out = await ch.send({ text: 'original' });
    const file = out.find((r) => r.kind === 'file');
    expect(file).toBeDefined();
    if (file?.kind === 'file') {
      expect(file.bytes.toString()).toContain('SEGUNDO');
      expect(file.bytes.toString()).not.toContain('PRIMERO');
    }
  });
});
