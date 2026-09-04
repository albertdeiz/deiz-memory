import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, search, show } from '../../src/core/index';
import type { Actor } from '../../src/core/domain/types';
import { rasterizePdf } from '../../src/adapters/normalize/documents';
import { ocrConverter } from '../../src/adapters/normalize/ocr';
import { speechConverter } from '../../src/adapters/normalize/whisper-http';
import { fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * The visual and audio lanes against the real services. What is tested here is
 * not model quality — that depends which one you load — but that the lane is
 * plugged in: bytes go out, text comes back, and that text becomes searchable.
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
    // The real criterion, by the path that will actually be used: send a photo of a
    // receipt and find it by what it says.
    stack.deps.converters = fakeConverters({ vision: ocr });
    const bytes = await readFile('fixtures/f1/boleta-escaneada.png');
    const res = await capture(stack.deps, actor, { bytes, filename: 'IMG_20260314_093312.png' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('vision');
    // The exact digits are the whole point of choosing OCR: a misread amount or
    // receipt number is worse than having nothing.
    expect(detail.value.normalizedText).toContain('88213');
    expect(detail.value.normalizedText).toContain('89.990');
    expect(detail.value.normalizedText).toContain('14/03/2026');

    const hit = await search(stack.deps, actor, { query: 'amoladora' });
    if (!hit.ok) throw new Error('no buscó');
    expect(hit.value).toHaveLength(1);
  }, 180_000);

  it('rasteriza un PDF escaneado y lo lee igual', async () => {
    if (!ocrUp) return;
    // OCR does not take PDFs: the document service rasterizes them. This test is the
    // one that proves that seam really works.
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

    // Speech synthesised on the spot: the fixture cannot be versioned without adding
    // a large binary to the repo, and the tool ships with the OS.
    const wav = await synthesize('El mecánico se llama Juan Pérez');
    if (!wav) return;

    const res = await capture(stack.deps, actor, { bytes: wav, filename: 'nota.wav' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('audio');
    // Unaccented: the tests run the smallest model, which drops accents. What is
    // tested here is that the lane is plugged in, not the model's quality — that
    // depends which one you load, and the real compose loads a larger one exactly
    // for this reason.
    const plano = (detail.value.normalizedText ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    expect(plano).toContain('mecanico');

    // And text search keeps doing its job over text that now comes from a model:
    // you search the way you type, accented or not.
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

/** The tool ships with macOS; elsewhere the test skips instead of failing. */
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
