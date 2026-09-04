import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPairingCode } from '../../src/core/index';
import type { Reply } from '../../src/core/channel/types';
import { fakeChannel, fileAttachment, oversizedAttachment, type FakeChannel } from '../../src/adapters/chat/fake';
import { serveChannel } from '../../src/adapters/chat/serve';
import { fakeConverter, fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

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
  return channel.send({ text: `/start ${c.value.code}` });
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
    expect(text(await ch.send({ text: '/capture el gasfiter es Rodrigo' }))).toContain('Guardado');
  });

  it('un código inventado no abre la puerta', async () => {
    expect(text(await ch.send({ text: '/start ZZZZZZZZ' }))).toContain('no sirve');
    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from channel_identities');
    expect(rows[0]!.n).toBe('0');
  });
});

describe('capturar', () => {
  beforeEach(async () => { await pairMe(); });

  it('guarda un texto suelto con /capture, y no promete leerlo', async () => {
    // Un texto ya es texto: no hay nada que un carril pueda agregarle.
    const out = text(await ch.send({ text: '/capture el mecánico es Juan +569 1234 5678' }));
    expect(out).toContain('Guardado');
    expect(out).not.toContain('Lo estoy leyendo');
  });

  it('un texto SIN /capture no se guarda: se consulta', async () => {
    // En un chat, lo que escribes es casi siempre algo que estás preguntando.
    // Guardar por defecto dejaba preguntas convertidas en memorias.
    const out = text(await ch.send({ text: 'el mecánico es Juan +569 1234 5678' }));
    expect(out).not.toContain('Guardado');
    const { rows } = await s.deps.db.query<{ n: string }>('select count(*)::text n from memories');
    expect(rows[0]!.n).toBe('0');
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
    // Son cosas distintas: una es el final de una lista, la otra una respuesta
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
    // Sin lista, un 7 no puede significar una posición. Se consulta, y si no
    // hay nada se ofrece guardarlo: no se pierde.
    const out = text(await ch.send({ text: '7' }));
    expect(out).toContain('No lo tengo');
    expect(text(await ch.send({ text: 'save' }))).toContain('Guardado');
  });

  it('ofrece guardar una pregunta que no encontró nada', async () => {
    const out = text(await ch.send({ text: '¿dónde está la garantía del refrigerador?' }));
    expect(out).toContain('No lo tengo');
    expect(out).toContain('guardar');

    expect(text(await ch.send({ text: 'save' }))).toContain('Guardado');
  });

  it('no ofrece guardar lo que buscaste a propósito', async () => {
    // Si escribiste /buscar querías buscar. Ofrecerte guardar "pinguino" como
    // nota sería guardarte un texto que nunca quisiste guardar.
    const out = text(await ch.send({ text: '/search pinguino' }));
    expect(out).toContain('No lo tengo');
    expect(out).not.toContain('guardar');
  });

  it('dice cuánto falta por leer, para no mentir con un "no lo tengo"', async () => {
    // Una búsqueda que responde "no lo tengo" mientras un OCR corre está
    // mintiendo. Es la métrica estrella de §15.
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

    // Otra persona, pareada a otro dueño, sobre el mismo canal.
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

describe('paridad con el CLI', () => {
  beforeEach(async () => { await pairMe(); });

  it('una pregunta se responde con cita; una búsqueda se lista', async () => {
    // Es la diferencia que el chat no hacía: preguntar traía cinco documentos
    // donde buscar, en vez del dato.
    s.deps.classifier = {
      async classify() { return {}; },
      async complete() { return 'El deducible es de 5 UF [1].'; },
      async available() { return { ok: true, detail: 'fake' }; },
    };
    // Sin embedder la recuperación degrada a full-text, que acá alcanza: lo
    // que se prueba es que preguntar responda, no la calidad del vector.
    s.deps.embedder = null;
    await ch.send({ text: '/capture el deducible de la póliza es de 5 UF por siniestro' });

    const preg = text(await ch.send({ text: '¿cuál es el deducible?' }));
    expect(preg).toContain('5 UF');
    expect(preg).toMatch(/\[[0-9a-f]{8}\]/);

    const busq = text(await ch.send({ text: '/search deducible' }));
    expect(busq).toContain('1–1');
  });

  it('se puede ocultar un resultado sin poder borrarlo', async () => {
    // El chat oculta; purgar es irreversible y se queda en la terminal.
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
    // Prometer un comando que no hace nada es peor que no tenerlo.
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
    // Descripción que no se solapa con la semilla, o el guardarraíl de §9
    // pediría confirmación y no habría nada que renombrar.
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
    // Un "sí" que llega media hora tarde no se refiere a lo que crees.
    const t0 = new Date('2026-03-14T12:00:00Z');
    await ch.send({ text: '/create Consultorio: Consultas médicas y recetas', at: t0 });
    await ch.send({ text: '/create Medico: Consultas médicas y recetas clínicas', at: t0 });
    const tarde = new Date(t0.getTime() + 40 * 60_000);
    expect(text(await ch.send({ text: 'yes', at: tarde }))).toContain('No hay nada esperando');
  });
});

describe('"ver 2" es el 2 de la lista que estoy mirando', () => {
  /**
   * El bug: `/documentos` numeraba sus cuatro resultados y ofrecía los botones
   * `ver N` sin registrar nunca esos ids en la sesión. Al pulsar el 2 salía el
   * segundo de la BÚSQUEDA anterior — un documento real, de otra cosa. Es el
   * peor tipo de fallo silencioso, porque parece una respuesta.
   */
  const guardar = async (body: string) => ch.send({ text: `/capture ${body}` });

  beforeEach(async () => {
    await pairMe();
    await s.deps.db.query(
      `insert into domains (owner_id, slug, label, description)
       values ($1,'papeles','Papeles','cédula, pasaporte, licencia')`, [s.ownerId]);
  });

  it('numerar una categoría no puede resolverse contra la lista anterior', async () => {
    // Una búsqueda deja SU lista en la sesión...
    await guardar('contrato de arriendo del departamento');
    await guardar('presupuesto de la mudanza');
    await ch.send({ text: '/search mudanza' });

    // ...y ahora una categoría con otras cosas, en otro orden.
    for (const t of ['cédula de identidad', 'licencia de conducir', 'pasaporte vigente']) {
      const r = await guardar(t);
      const id = /([0-9a-f]{8})/.exec(text(r))?.[1];
      await s.deps.db.query(
        `update memories set domain_id = (select id from domains where owner_id=$2 and slug='papeles')
          where id::text like $1 || '%'`, [id, s.ownerId]);
    }

    const lista = text(await ch.send({ text: '/papeles' }));
    // El segundo de lo que se mostró, leído de la propia respuesta.
    const segundo = /^2\. (.+)$/m.exec(lista)?.[1]?.trim();
    expect(segundo).toBeTruthy();

    const detalle = text(await ch.send({ text: 'view:2' }));
    expect(detalle).toContain(segundo!.split('\n')[0]!);
    // Y desde luego nada de la búsqueda de antes.
    expect(detalle).not.toContain('mudanza');
  });

  it('una categoría vacía no deja viva la lista anterior', async () => {
    await guardar('presupuesto de la mudanza');
    await ch.send({ text: '/search mudanza' });
    await ch.send({ text: '/papeles' });
    // No hay nada en Papeles, así que "ver 1" no puede abrir la mudanza.
    expect(text(await ch.send({ text: 'view:1' }))).not.toContain('mudanza');
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
    const acciones = lista.flatMap((r) => (r.kind === 'text' ? (r.options ?? []).map((o) => o.action) : []));
    expect(acciones).toContain('open:1');

    const out = await ch.send({ text: 'open:1' });
    const file = out.find((r) => r.kind === 'file');
    expect(file).toBeDefined();
    if (file?.kind === 'file') expect(file.bytes.toString()).toContain('Amoladora');
  });

  it('"mandarme el original" desde el detalle no manda el de otro', async () => {
    // El botón codificaba `abrir:1`, así que abrir el segundo y pedir su
    // original devolvía el archivo del primero de la lista.
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
