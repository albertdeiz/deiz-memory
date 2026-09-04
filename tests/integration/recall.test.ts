import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { answer, capture, createDomain, indexMemory, retrieve } from '../../src/core/index';
import type { Actor } from '../../src/core/domain/types';
import type { Classifier, Embedder } from '../../src/core/ports';
import { fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * Hybrid retrieval and answering with a citation.
 *
 * The embedder is fake and deterministic on purpose: what is tested is that the
 * structured filter cuts first, that the two paths fuse, and that an answer with
 * no citation is NOT shown. None of that depends on how good the model is, and
 * testing it against a real one would be testing the model.
 */
let s: TestStack;
let actor: Actor;

/** Deterministic vector: same text, same vector; similar texts, similar vectors. */
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
    // The case measured on a real policy: the paragraph that answers says
    // "deductible" and does not say "car". With AND it returned zero results.
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
    await guardar('query antigua con el doctor', { occurredAt: new Date('2024-01-15') });
    await guardar('query reciente con el doctor', { occurredAt: new Date('2026-05-20') });

    const r = await retrieve(s.deps, actor, { query: 'query doctor', from: new Date('2025-01-01') });
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
    // Retrieving per chunk is right — the model needs the paragraph — but showing
    // presentarlo por trozo es mentira de interfaz: en el chat "ver 1", "ver 2"
    // and "view 3" opened the same file.
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
    expect(r.value[0]!.via).toBe('text');
  });
});

describe('responder con cita (regla dura 1)', () => {
  beforeEach(async () => { await guardar('el deducible de la póliza es de 5 UF por siniestro'); });

  it('devuelve la respuesta cuando trae cita, resuelta a un id', async () => {
    s.deps.classifier = fakeClassifier('El deducible es de 5 UF por siniestro [1].');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    // The citation points at an openable id, not a number that means nothing half
    // an hour later.
    expect(r.value.text).toMatch(/\[[0-9a-f]{8}\]/);
    expect(r.value.reason).toBeNull();
  });

  it('DESCARTA una respuesta sin cita, aunque suene bien', async () => {
    // Verified in code and not trusted to the prompt: with no verifiable backing a
    // respaldo verificable no se muestra un dato factual.
    s.deps.classifier = fakeClassifier('El deducible es de 5 UF por siniestro.');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.text).toBeNull();
    expect(r.value.reason).toBe('no_citation');
    // The passages are still shown: they are verifiable truth.
    expect(r.value.sources.length).toBeGreaterThan(0);
  });

  it('respeta el NO_LO_TENGO del modelo', async () => {
    s.deps.classifier = fakeClassifier('NO_LO_TENGO');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.text).toBeNull();
    expect(r.value.reason).toBe('no_results');
  });

  it('sin resultados dice que no lo tiene, sin llamar al modelo', async () => {
    let llamado = false;
    s.deps.classifier = { ...fakeClassifier('algo'), async complete() { llamado = true; return 'x'; } };
    const r = await answer(s.deps, actor, { query: 'pinguinos antarticos', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.reason).toBe('no_results');
    expect(llamado).toBe(false);
  });

  it('DESCARTA una cifra que no está en los pasajes, aunque la cita sea válida', async () => {
    // The real failure behind this: the citation pointed at a document that exists
    // and the number was nowhere in what the model read. An answer like that is
    // MORE believable than one with no citation, which is why it is the worst.
    s.deps.classifier = fakeClassifier('El deducible es de 12 UF por siniestro [1].');
    const r = await answer(s.deps, actor, { query: 'deducible', synthesize: true });
    if (!r.ok) throw new Error('falló');
    expect(r.value.text).toBeNull();
    expect(r.value.reason).toBe('ungrounded');
    expect(r.value.sources.length).toBeGreaterThan(0);
  });

  it('la misma cifra escrita distinto sí pasa', async () => {
    // The same figure written two ways is the same datum. Without normalizing,
    // this guard would discard precisely the correct answers.
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

/**
 * Match on every term, rank on the ones that discriminate.
 *
 * OR-ing a question is right — requiring every word discards the paragraph that
 * answers — but ranking with OR gives full credit to the words that only say
 * which document we are talking about, and those are on every page of it.
 * Measured on a real policy: two topic words in 15-16% of the chunks against 4%
 * for the discriminating one. The chunk carrying the figure came seventh, and
 * the model only reads the first few.
 */
describe('las palabras de tema no deciden el orden', () => {
  beforeEach(async () => {
    // Nine chunks saturated with the topic words and carrying no datum. It is what a
    // policy does: every page repeats the same two words.
    for (let i = 1; i <= 9; i++) {
      await guardar(`Clausula ${i}. ${'El seguro del vehiculo asegurado. '.repeat(12)}`);
    }
    // ...and one that mentions them ONCE and carries the datum that answers.
    await guardar('Tabla de coberturas del seguro de vehiculo: deducible UF 3,0 por siniestro.');
  });

  it('el trozo con la palabra rara gana, aunque los otros repitan el tema', async () => {
    const r = await retrieve(s.deps, actor, {
      query: 'cuanto es mi deducible en el seguro de mi vehiculo',
    });
    if (!r.ok) throw new Error('falló');
    expect(r.value[0]?.content).toContain('deducible UF 3,0');
  });

  it('con una sola palabra no hay nada que descartar', async () => {
    const r = await retrieve(s.deps, actor, { query: 'deducible' });
    if (!r.ok) throw new Error('falló');
    expect(r.value[0]?.content).toContain('deducible UF 3,0');
  });

  it('si todas son igual de comunes, siguen contando todas', async () => {
    // Without this, a badly placed threshold would leave the query with no terms.
    const r = await retrieve(s.deps, actor, { query: 'seguro vehiculo' });
    if (!r.ok) throw new Error('falló');
    expect(r.value.length).toBeGreaterThan(0);
  });
});
