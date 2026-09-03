import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { answer, capture, createDomain, indexMemory, retrieve } from '../../src/core/index.js';
import type { Actor } from '../../src/core/domain/types.js';
import type { Classifier, Embedder } from '../../src/core/ports.js';
import { fakeConverters } from '../helpers/converters.js';
import { startStack, type TestStack } from '../helpers/stack.js';

/**
 * Recuperación híbrida y respuesta con cita (§6, reglas duras 1 y 2).
 *
 * El embedder es falso y determinista a propósito: lo que se prueba es que el
 * filtro estructurado recorte primero, que los dos caminos se fusionen, y que
 * una respuesta sin cita NO se muestre. Nada de eso depende de qué tan bueno
 * sea el modelo, y probarlo contra uno real sería probar el modelo.
 */
let s: TestStack;
let actor: Actor;

/** Vector determinista: mismo texto, mismo vector; textos parecidos, parecidos. */
const fakeEmbedder = (): Embedder => ({
  dimensions: 768,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(768).fill(0);
      for (const w of t.toLowerCase().match(/[a-záéíóúñ]+/g) ?? []) {
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 768;
        v[h] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
  async available() { return { ok: true, detail: 'fake' }; },
});

const fakeClassifier = (respuesta: string): Classifier => ({
  async classify() { return {}; },
  async complete() { return respuesta; },
  async available() { return { ok: true, detail: 'fake' }; },
});

beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s.close(); });
beforeEach(async () => {
  await s.reset();
  actor = { ownerId: s.ownerId };
  s.deps.converters = fakeConverters();
  s.deps.embedder = fakeEmbedder();
  s.deps.classifier = null;
});

const guardar = async (text: string, opts: { domain?: string; occurredAt?: Date } = {}) => {
  const r = await capture(s.deps, actor, { text, ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}) });
  if (!r.ok) throw new Error('no capturó');
  if (opts.domain) {
    await s.deps.db.query(
      'update memories set domain_id = (select id from domains where owner_id=$2 and slug=$3) where id = $1',
      [r.value.id, s.ownerId, opts.domain]);
  }
  await indexMemory(s.deps, actor, r.value.id);
  return r.value.id;
};

describe('recuperación híbrida', () => {
  it('encuentra por coincidencia exacta de palabra', async () => {
    await guardar('el deducible de la póliza es de 5 UF por siniestro');
    await guardar('el gasfiter se llama Rodrigo');

    const r = await retrieve(s.deps, actor, { query: 'deducible' });
    if (!r.ok) throw new Error('falló');
    expect(r.value[0]!.content).toContain('deducible');
  });

  it('una pregunta no exige TODAS sus palabras', async () => {
    // El caso medido sobre una póliza real: el párrafo que responde dice
    // "deducible" y no dice "auto". Con AND daba cero resultados.
    await guardar('DEDUCIBLE INTELIGENTE: el deducible establecido es de 3 UF');

    const r = await retrieve(s.deps, actor, { query: '¿cuál es el deducible de mi seguro de auto?' });
    if (!r.ok) throw new Error('falló');
    expect(r.value.length).toBeGreaterThan(0);
  });

  it('el filtro por dominio recorta ANTES de buscar', async () => {
    await createDomain(s.deps.db, actor, { label: 'Autos', description: 'cosas del vehículo', confirm: true });
    await guardar('la póliza cubre daño propio', { domain: 'salud' });
    await guardar('la póliza cubre daño propio también', { domain: 'autos' });

    const r = await retrieve(s.deps, actor, { query: 'póliza', domain: 'autos' });
    if (!r.ok) throw new Error('falló');
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.domainLabel).toBe('Autos');
  });

  it('el filtro por fecha usa cuándo pasó, no cuándo lo guardaste', async () => {
    await guardar('consulta antigua con el doctor', { occurredAt: new Date('2024-01-15') });
    await guardar('consulta reciente con el doctor', { occurredAt: new Date('2026-05-20') });

    const r = await retrieve(s.deps, actor, { query: 'consulta doctor', desde: new Date('2025-01-01') });
    if (!r.ok) throw new Error('falló');
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.content).toContain('reciente');
  });

  it('un dominio que no existe es un error, no un resultado vacío', async () => {
    const r = await retrieve(s.deps, actor, { query: 'algo', domain: 'pinguinos' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not_found');
  });

  it('no ves los trozos de otro dueño', async () => {
    const otro = { ownerId: s.otherOwnerId };
    const m = await capture(s.deps, otro, { text: 'la póliza secreta de otra persona' });
    if (!m.ok) throw new Error('no capturó');
    await indexMemory(s.deps, otro, m.value.id);

    const r = await retrieve(s.deps, actor, { query: 'póliza secreta' });
    if (!r.ok) throw new Error('falló');
    expect(r.value).toHaveLength(0);
  });

  it('un documento con varios trozos que calzan figura UNA vez en las fuentes', async () => {
    // Recuperar por trozo es correcto —el modelo necesita el párrafo—, pero
    // presentarlo por trozo es mentira de interfaz: en el chat "ver 1", "ver 2"
    // y "ver 3" abrían el mismo archivo.
    const parrafo = (n: number) => `El deducible de la sección ${n} es relevante. ${'x'.repeat(900)}`;
    await guardar([parrafo(1), parrafo(2), parrafo(3)].join('\n\n'));
    const r = await answer(s.deps, actor, { query: 'deducible' });
    if (!r.ok) throw new Error('falló');
    const ids = r.value.sources.map((p) => p.memoryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sin embedder degrada a full-text en vez de fallar', async () => {
    await guardar('el deducible es de 5 UF');
    s.deps.embedder = null;
    const r = await retrieve(s.deps, actor, { query: 'deducible' });
    if (!r.ok) throw new Error('falló');
    expect(r.value.length).toBeGreaterThan(0);
    expect(r.value[0]!.via).toBe('texto');
  });
});

describe('responder con cita (regla dura 1)', () => {
  beforeEach(async () => { await guardar('el deducible de la póliza es de 5 UF por siniestro'); });

  it('devuelve la respuesta cuando trae cita, resuelta a un id', async () => {
    s.deps.classifier = fakeClassifier('El deducible es de 5 UF por siniestro [1].');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    // La cita apunta a un id abrible, no a un número que no significa nada
    // media hora después.
    expect(r.value.text).toMatch(/\[[0-9a-f]{8}\]/);
    expect(r.value.reason).toBeNull();
  });

  it('DESCARTA una respuesta sin cita, aunque suene bien', async () => {
    // Es la regla dura 1 verificada en código y no confiada al prompt: sin
    // respaldo verificable no se muestra un dato factual.
    s.deps.classifier = fakeClassifier('El deducible es de 5 UF por siniestro.');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.text).toBeNull();
    expect(r.value.reason).toBe('sin_cita');
    // Pero los pasajes sí se muestran: son verdad verificable.
    expect(r.value.sources.length).toBeGreaterThan(0);
  });

  it('respeta el NO_LO_TENGO del modelo', async () => {
    s.deps.classifier = fakeClassifier('NO_LO_TENGO');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.text).toBeNull();
    expect(r.value.reason).toBe('sin_resultados');
  });

  it('sin resultados dice que no lo tiene, sin llamar al modelo', async () => {
    let llamado = false;
    s.deps.classifier = { ...fakeClassifier('algo'), async complete() { llamado = true; return 'x'; } };
    const r = await answer(s.deps, actor, { query: 'pinguinos antarticos', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.reason).toBe('sin_resultados');
    expect(llamado).toBe(false);
  });

  it('DESCARTA una cifra que no está en los pasajes, aunque la cita sea válida', async () => {
    // El fallo real que motivó esto: la cita apuntaba a un documento que existe
    // y el número no estaba en ninguna parte de lo que el modelo leyó. Una
    // respuesta así es MÁS creíble que una sin cita, y por eso es la peor.
    s.deps.classifier = fakeClassifier('El deducible es de 12 UF por siniestro [1].');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.text).toBeNull();
    expect(r.value.reason).toBe('sin_respaldo');
    expect(r.value.sources.length).toBeGreaterThan(0);
  });

  it('la misma cifra escrita distinto sí pasa', async () => {
    // "UF 5,0" en el documento y "5 UF" en la respuesta son el mismo dato. Sin
    // normalizar, este guardarraíl descartaría justo las respuestas correctas.
    await guardar('cobertura de sismo con deducible UF 5,0 por evento');
    s.deps.classifier = fakeClassifier('El deducible es de 5 UF [1].');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.reason).toBeNull();
    expect(r.value.text).toMatch(/5 UF/);
  });

  it('sin sintetizar devuelve los pasajes, que ya sirven', async () => {
    const r = await answer(s.deps, actor, { query: 'deducible' });
    if (!r.ok) throw new Error('falló');
    expect(r.value.text).toBeNull();
    expect(r.value.sources.length).toBeGreaterThan(0);
    expect(r.value.reason).toBeNull();
  });
});
