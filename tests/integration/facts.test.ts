import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  askFacts, capture, extractFacts, listFacts, listFactTypes, matchFields,
} from '../../src/core/index.js';
import type { Actor } from '../../src/core/domain/types.js';
import type { Classifier } from '../../src/core/ports.js';
import { fakeConverters } from '../helpers/converters.js';
import { startStack, type TestStack } from '../helpers/stack.js';

/**
 * Datos tipados (§4) y el modo hecho (§6).
 *
 * El modelo es falso y devuelve lo que el test le dice: lo que se prueba es la
 * validación, la supersesión y la diferencia entre `estado` y `periodo`. Nada
 * de eso depende de qué tan bueno sea el modelo, y probarlo contra uno real
 * sería probar el modelo.
 */
let s: TestStack;
let actor: Actor;

const modelo = (respuesta: unknown): Classifier => ({
  async classify() { return respuesta; },
  async complete() { return ''; },
  async available() { return { ok: true, detail: 'fake' }; },
});

const POLIZA = [
  'Póliza de Seguro de Vehículo N° B-VP-9344586-4',
  'Patente VHWD58 · Deducible UF 3,0 por siniestro',
  'Vigencia: 29-07-2026 hasta 29-07-2029',
].join('\n');

const CARTOLA = [
  'ESTADO DE CUENTA TARJETA DE CRÉDITO XXXXX4005',
  'PERÍODO FACTURADO 24/07/2026 al 21/08/2026',
  'MONTO FACTURADO A PAGAR $886.568 — PAGAR HASTA 07/09/2026',
].join('\n');

beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s.close(); });
beforeEach(async () => {
  await s.reset();
  actor = { ownerId: s.ownerId };
  s.deps.converters = fakeConverters();
  s.deps.embedder = null;
  s.deps.classifier = null;
});

/** Guarda un texto y lo pone en un dominio, sin pasar por el clasificador. */
const guardar = async (text: string, slug: string) => {
  const r = await capture(s.deps, actor, { text });
  if (!r.ok) throw new Error('no capturó');
  await s.deps.db.query(
    `update memories set domain_id = (select id from domains where owner_id=$2 and slug=$3)
      where id = $1`,
    [r.value.id, s.ownerId, slug],
  );
  return r.value.id;
};

describe('extraer', () => {
  it('guarda los campos que el documento respalda', async () => {
    const id = await guardar(POLIZA, 'seguros');
    s.deps.classifier = modelo({
      aplica: true,
      campos: {
        numero: 'B-VP-9344586-4', patente: 'VHWD58', deducible: '3,0',
        vigencia_desde: '29-07-2026', vigencia_hasta: '29-07-2029',
      },
    });
    const r = await extractFacts(s.deps, actor, id);
    if (!r.ok) throw new Error('falló');
    expect(r.value.extracted).toContain('poliza_auto');

    const [f] = await listFacts(s.deps.db, actor);
    expect(f!.payload.deducible).toBe(3);
    expect(f!.payload.patente).toBe('VHWD58');
    // La vigencia sale de los campos que el registro declara, no hardcodeada.
    expect(f!.validFrom?.toISOString().slice(0, 10)).toBe('2026-07-29');
  });

  it('DESCARTA un campo que el documento no dice, y guarda el resto', async () => {
    // Es lo que separa un dato extraído de una alucinación con buen formato.
    const id = await guardar(POLIZA, 'seguros');
    s.deps.classifier = modelo({
      aplica: true,
      campos: { patente: 'VHWD58', deducible: '5,0', vigencia_desde: '29-07-2026' },
    });
    const r = await extractFacts(s.deps, actor, id);
    if (!r.ok) throw new Error('falló');
    expect(r.value.discarded).toContain('poliza_auto.deducible');

    const [f] = await listFacts(s.deps.db, actor);
    expect(f!.payload.deducible).toBeUndefined();
    expect(f!.payload.patente).toBe('VHWD58');
  });

  it('sin el campo identidad no es de ese tipo', async () => {
    // Sobre el corpus real, una liquidación de siniestro y un certificado de
    // cobertura se tipificaban como póliza aunque la descripción los excluía.
    // Un modelo chico lee esa exclusión y la ignora; un `if` no.
    const id = await guardar('Informe de liquidación. Deducible UF 3,0 aplicado.', 'seguros');
    s.deps.classifier = modelo({ aplica: true, campos: { deducible: '3,0' } });
    const r = await extractFacts(s.deps, actor, id);
    if (!r.ok) throw new Error('falló');
    expect(r.value.extracted).toEqual([]);
    expect(await listFacts(s.deps.db, actor)).toHaveLength(0);
  });

  it('si el modelo dice que no aplica, se le cree', async () => {
    const id = await guardar('Boleta del supermercado, $12.500', 'seguros');
    s.deps.classifier = modelo({ aplica: false });
    const r = await extractFacts(s.deps, actor, id);
    if (!r.ok) throw new Error('falló');
    expect(r.value.extracted).toEqual([]);
  });

  it('solo se intentan los tipos de ese dominio', async () => {
    // Una boleta del supermercado no tiene por qué pasar por el extractor de
    // pólizas: el filtro por dominio es lo que hace barato el mecanismo.
    let llamadas = 0;
    const id = await guardar(POLIZA, 'salud');
    s.deps.classifier = {
      ...modelo({ aplica: false }),
      async classify() { llamadas++; return { aplica: false }; },
    };
    await extractFacts(s.deps, actor, id);
    expect(llamadas).toBe(0);
  });
});

describe('estado y periodo no se tratan igual', () => {
  const guardarPoliza = async (patente: string, desde: string, hasta: string) => {
    const texto = `Póliza N° X · Patente ${patente} · Deducible UF 3,0 · ${desde} a ${hasta}`;
    const id = await guardar(texto, 'seguros');
    s.deps.classifier = modelo({
      aplica: true,
      campos: { patente, deducible: '3,0', vigencia_desde: desde, vigencia_hasta: hasta },
    });
    await extractFacts(s.deps, actor, id);
    return id;
  };

  it('una póliza posterior supera a la anterior si no se solapan', async () => {
    await guardarPoliza('VHWD58', '01-01-2020', '01-01-2023');
    await guardarPoliza('VHWD58', '01-01-2023', '01-01-2026');

    const vivos = await listFacts(s.deps.db, actor);
    expect(vivos).toHaveLength(1);
    expect(vivos[0]!.validFrom?.toISOString().slice(0, 10)).toBe('2023-01-01');

    // La vieja no se borró: sigue respondiendo "¿qué cubría antes?".
    expect(await listFacts(s.deps.db, actor, { includeSuperseded: true })).toHaveLength(2);
  });

  it('dos vigencias que se solapan son un CONFLICTO, no una sucesión', async () => {
    // Regla dura 3: se muestran las dos y jamás se elige una en silencio.
    await guardarPoliza('VHWD58', '01-01-2023', '01-01-2027');
    await guardarPoliza('VHWD58', '01-01-2026', '01-01-2029');
    expect(await listFacts(s.deps.db, actor)).toHaveLength(2);
  });

  it('una cartola NO supera a la del mes anterior', async () => {
    // La de julio sigue siendo la verdad sobre julio, para siempre. Sin la
    // distinción `periodo`, agosto la habría marcado superada.
    for (const [desde, hasta] of [['24/06/2026', '21/07/2026'], ['24/07/2026', '21/08/2026']]) {
      const id = await guardar(`TARJETA XXXXX4005\nPERIODO FACTURADO ${desde} al ${hasta}`, 'finanzas');
      s.deps.classifier = modelo({
        aplica: true,
        campos: { tarjeta: 'XXXXX4005', periodo_desde: desde, periodo_hasta: hasta },
      });
      await extractFacts(s.deps, actor, id);
    }
    expect(await listFacts(s.deps.db, actor)).toHaveLength(2);
  });
});

describe('el modo hecho responde', () => {
  const ahora = new Date('2026-09-01T12:00:00Z');

  it('una palabra de la pregunta calza con el alias de un campo', async () => {
    const types = await listFactTypes(s.deps.db, actor);
    const refs = matchFields('cuanto es mi deducible', types);
    expect(refs.map((r) => r.field.name)).toContain('deducible');
  });

  it('calza conjugaciones, no solo la palabra exacta', async () => {
    // "cuánto PAGA mi tarjeta" no calzaba con el alias `pagar`. Pedirle a quien
    // define un tipo que enumere pagar/paga/pago/pagos es pedirle que conjugue.
    const types = await listFactTypes(s.deps.db, actor);
    for (const q of ['cuanto paga la tarjeta', 'cuanto pago', 'cuanto tengo que pagar']) {
      expect(matchFields(q, types).map((r) => r.field.name), q).toContain('monto_a_pagar');
    }
    // Y "vence" tiene que llegar a "vencimiento", que ninguna raíz junta.
    expect(matchFields('cuando vence', types).map((r) => r.field.name)).toContain('pagar_hasta');
  });

  it('no confunde palabras que solo comparten dos letras', async () => {
    const types = await listFactTypes(s.deps.db, actor);
    // `tasa` y `tarjeta` empiezan igual y no son lo mismo.
    expect(matchFields('de que tarjeta', types).map((r) => r.field.name)).not.toContain('tasa');
  });

  it('una pregunta sin campo no abre el camino de hechos', async () => {
    const types = await listFactTypes(s.deps.db, actor);
    expect(matchFields('que me recetaron en marzo', types)).toEqual([]);
  });

  it('devuelve el valor con su cita', async () => {
    const id = await guardar(POLIZA, 'seguros');
    s.deps.classifier = modelo({
      aplica: true,
      campos: { patente: 'VHWD58', deducible: '3,0', vigencia_desde: '29-07-2026', vigencia_hasta: '29-07-2029' },
    });
    await extractFacts(s.deps, actor, id);

    const hits = await askFacts(s.deps.db, actor, 'cuanto es mi deducible', ahora);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe(3);
    expect(hits[0]!.fact.memoryId).toBe(id);
    expect(hits[0]!.expired).toBe(false);
  });

  it('marca vencido lo que ya no vale, sin ocultarlo', async () => {
    // Regla dura 10: se dice ANTES del dato. Que sea un booleano y no prosa es
    // lo que permite comprobar el orden en los dos canales.
    const id = await guardar(
      'Póliza N° X · Patente ABCD12 · Deducible UF 9,0 · 01-01-2020 a 01-01-2021', 'seguros');
    s.deps.classifier = modelo({
      aplica: true,
      campos: { patente: 'ABCD12', deducible: '9,0', vigencia_desde: '01-01-2020', vigencia_hasta: '01-01-2021' },
    });
    await extractFacts(s.deps, actor, id);

    const hits = await askFacts(s.deps.db, actor, 'cuanto es mi deducible', ahora);
    expect(hits[0]!.expired).toBe(true);
    expect(hits[0]!.value).toBe(9);
  });

  it('en un periodo no existe "vencido": julio sigue siendo julio', async () => {
    const id = await guardar('TARJETA XXXXX4005\nPERIODO FACTURADO 24/06/2026 al 21/07/2026', 'finanzas');
    s.deps.classifier = modelo({
      aplica: true,
      campos: { tarjeta: 'XXXXX4005', periodo_desde: '24/06/2026', periodo_hasta: '21/07/2026' },
    });
    await extractFacts(s.deps, actor, id);

    const hits = await askFacts(s.deps.db, actor, 'de que periodo', ahora);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.expired)).toBe(true);
  });

  it('no ves los hechos de otro dueño', async () => {
    const id = await guardar(POLIZA, 'seguros');
    s.deps.classifier = modelo({
      aplica: true,
      campos: { patente: 'VHWD58', deducible: '3,0', vigencia_desde: '29-07-2026' },
    });
    await extractFacts(s.deps, actor, id);
    expect(await askFacts(s.deps.db, { ownerId: s.otherOwnerId }, 'deducible', ahora)).toEqual([]);
  });
});
