import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, search, show } from '../../src/core/index.js';
import type { Actor } from '../../src/core/domain/types.js';
import { rasterizePdf } from '../../src/adapters/normalize/documents.js';
import { ocrConverter } from '../../src/adapters/normalize/ocr.js';
import { speechConverter } from '../../src/adapters/normalize/whisper-http.js';
import { fakeConverters } from '../helpers/converters.js';
import { startStack, type TestStack } from '../helpers/stack.js';

/**
 * Los carriles B y C contra los servicios de verdad. Lo que se prueba acá no es
 * la calidad del modelo —eso depende de cuál cargues— sino que el carril esté
 * enchufado: que los bytes salgan, vuelva texto, y ese texto quede buscable.
 */
const docsCfg = { baseUrl: process.env.DM_DOCUMENTS_URL ?? 'http://localhost:8091', timeoutMs: 120_000 };
const ocr = ocrConverter(
  { baseUrl: process.env.DM_OCR_URL ?? 'http://localhost:8093', timeoutMs: 300_000 },
  (bytes) => rasterizePdf(docsCfg, bytes),
);
const speech = speechConverter({
  baseUrl: process.env.DM_SPEECH_URL ?? 'http://localhost:8092/v1',
  model: process.env.DM_SPEECH_MODEL ?? 'tiny',
  language: 'es',
  apiKey: null,
  timeoutMs: 300_000,
});

let stack: TestStack;
let actor: Actor;
let ocrUp = false;
let speechUp = false;

beforeAll(async () => {
  stack = await startStack();
  ocrUp = (await ocr.available()).ok;
  speechUp = (await speech.available()).ok;
  if (!ocrUp) console.warn('el servicio de OCR no responde — se saltan los tests del carril B');
  if (!speechUp) console.warn('el servicio de whisper no responde — se saltan los tests del carril C');
}, 180_000);
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.reset();
  actor = { ownerId: stack.ownerId };
});

describe('carril B · OCR local', () => {
  it('lee una boleta fotografiada, con montos y fecha exactos', async () => {
    if (!ocrUp) return;
    // El criterio de F1, por el camino que de verdad se va a usar: "mandas la
    // foto de una boleta y la encuentras buscando por lo que dice".
    stack.deps.converters = fakeConverters({ vision: ocr });
    const bytes = await readFile('fixtures/f1/boleta-escaneada.png');
    const res = await capture(stack.deps, actor, { bytes, filename: 'IMG_20260314_093312.png' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('vision');
    // Los dígitos exactos son el punto entero de haber elegido OCR: un monto o
    // un número de boleta mal leído es peor que no tener nada.
    expect(detail.value.normalizedText).toContain('88213');
    expect(detail.value.normalizedText).toContain('89.990');
    expect(detail.value.normalizedText).toContain('14/03/2026');

    const hit = await search(stack.deps, actor, { query: 'amoladora' });
    if (!hit.ok) throw new Error('no buscó');
    expect(hit.value).toHaveLength(1);
  }, 180_000);

  it('rasteriza un PDF escaneado y lo lee igual', async () => {
    if (!ocrUp) return;
    // El OCR no recibe PDF: lo rasteriza el sidecar de documentos. Este test es
    // el que prueba que esa costura funciona de verdad.
    stack.deps.converters = fakeConverters({ vision: ocr });
    const bytes = await readFile('fixtures/f1/escaneo.pdf');
    const res = await capture(stack.deps, actor, { bytes, filename: 'escaneo.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizedText).toContain('ROBLE');
    expect(detail.value.normalizationError).toBeNull();
  }, 300_000);

  it('rechaza un formato que no es imagen, con el nombre del formato', async () => {
    await expect(
      ocr.extract({ bytes: Buffer.from('x'), mediaType: 'image/heic', filename: 'foto.heic' }),
    ).rejects.toThrow(/image\/heic/);
  });
});

describe('carril C · transcripción', () => {
  it('transcribe una nota de voz en español y la deja buscable', async () => {
    if (!speechUp) return;
    stack.deps.converters = fakeConverters({ audio: speech });

    // Voz sintetizada en el momento: el fixture no se puede versionar sin meter
    // un binario grande al repo, y `say` viene con macOS.
    const wav = await synthesize('El mecánico se llama Juan Pérez');
    if (!wav) return;

    const res = await capture(stack.deps, actor, { bytes: wav, filename: 'nota.wav' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('audio');
    // Sin tildes: los tests corren con el modelo `tiny`, que escribe "mecanico"
    // a secas. Lo que se prueba acá es que el carril está enchufado, no la
    // calidad del modelo — esa depende de cuál cargues, y en el compose de
    // verdad es `small` justamente por esto.
    const plano = (detail.value.normalizedText ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    expect(plano).toContain('mecanico');

    // Y el tsvector de F0 sigue haciendo su trabajo sobre texto que ahora viene
    // de un modelo: buscas como escribes, con o sin tilde.
    const hit = await search(stack.deps, actor, { query: 'mecanico' });
    if (!hit.ok) throw new Error('no buscó');
    expect(hit.value).toHaveLength(1);
  }, 300_000);

  it('dice qué pasa cuando el servicio no está', async () => {
    const roto = speechConverter({
      baseUrl: 'http://localhost:9/v1', model: 'tiny', language: 'es', apiKey: null, timeoutMs: 3_000,
    });
    const state = await roto.available();
    expect(state.ok).toBe(false);
    expect(state.detail).toMatch(/no pude conectarme a whisper/);
  }, 30_000);
});

/** macOS trae `say`; en otro sistema el test se salta en vez de fallar. */
async function synthesize(text: string): Promise<Buffer | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const out = '/tmp/dm-test-nota.wav';
  try {
    await run('say', ['-o', out, '--data-format=LEI16@16000', text]);
    return await readFile(out);
  } catch {
    return null;
  }
}
