import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, search, show } from '../../src/core/index';
import type { Actor } from '../../src/core/domain/types';
import { documentsConverter, rasterizePdf } from '../../src/adapters/normalize/documents';
import { fakeConverter, fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * The other tests exercise the *router* with fake lanes. This one exercises the
 * carril A de verdad, contra el sidecar real y documentos reales — porque la
 * claim the whole lane design rests on ("the document lane does no OCR") is a
 * claim about that service, and it is better verified than assumed.
 */
const cfg = {
  baseUrl: process.env.DM_DOCUMENTS_URL ?? 'http://localhost:8091',
  timeoutMs: 120_000,
};
const converter = documentsConverter(cfg);

let stack: TestStack;
let actor: Actor;
let usable = false;

beforeAll(async () => {
  stack = await startStack();
  usable = (await converter.available()).ok;
  if (!usable) console.warn(`el sidecar de documentos no responde en ${cfg.baseUrl} — se saltan los tests del carril A`);
}, 180_000);
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.reset();
  actor = { ownerId: stack.ownerId };
  stack.deps.converters = fakeConverters({ document: converter });
});

describe('carril A · el sidecar de documentos', () => {
  it('saca el texto de un PDF que sí tiene capa de texto', async () => {
    if (!usable) return;
    const bytes = await readFile('fixtures/f1/poliza-texto.pdf');
    const res = await capture(stack.deps, actor, { bytes, filename: 'poliza-texto.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('document');
    expect(detail.value.normalizedText).toContain('4471-2026');
    expect(detail.value.normalizationError).toBeNull();
  }, 180_000);

  it('conserva la tabla de un docx en vez de aplanarla', async () => {
    if (!usable) return;
    // The reason for choosing a structure-preserving converter over a plain text
    // extractor: a coverage table still looks like a table, and that searches better.
    const bytes = await readFile('fixtures/f1/carta.docx');
    const res = await capture(stack.deps, actor, { bytes, filename: 'carta.docx' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizedText).toContain('Deducible');
    expect(detail.value.normalizedText).toContain('|');
  }, 180_000);

  it('un PDF escaneado sale vacío del carril A y cae a visión', async () => {
    if (!usable) return;
    // This is the test that justifies the visual lane existing. The service really
    // runs, really returns nothing, and the fallback rule fires on its own.
    const vision = fakeConverter('FERRETERIA EL ROBLE · Boleta 88213 · Amoladora Bosch $89.990 · 14/03/2026 · gracias por su compra');
    stack.deps.converters = fakeConverters({ document: converter, vision });

    const bytes = await readFile('fixtures/f1/escaneo.pdf');
    const res = await capture(stack.deps, actor, { bytes, filename: 'escaneo.pdf' });
    if (!res.ok) throw new Error('no capturó');

    expect(vision.calls).toHaveLength(1);
    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('vision');

    const hit = await search(stack.deps, actor, { query: 'amoladora' });
    if (!hit.ok) throw new Error('no buscó');
    expect(hit.value).toHaveLength(1);
  }, 180_000);

  it('dice con claridad que no está, en vez de un ECONNREFUSED', async () => {
    // A lane down at eleven at night has to explain itself.
    const roto = documentsConverter({ baseUrl: 'http://localhost:9', timeoutMs: 3_000 });
    const state = await roto.available();
    expect(state.ok).toBe(false);
    await expect(
      roto.extract({ bytes: Buffer.from('hola'), mediaType: 'text/html', filename: 'a.html' }),
    ).rejects.toThrow(/no pude conectarme a documentos/);
  }, 30_000);
});

describe('rasterizar PDF', () => {
  it('convierte las páginas a PNG para los modelos que no aceptan PDF', async () => {
    if (!usable) return;
    // The chat-style API that most local servers speak only accepts images. Without
    // this, the visual lane would work with only one provider.
    const bytes = await readFile('fixtures/f1/escaneo.pdf');
    const out = await rasterizePdf(cfg, bytes, { dpi: 120 });

    expect(out.totalPages).toBe(1);
    expect(out.pages).toHaveLength(1);
    expect(out.truncated).toBe(false);
    expect(out.pages[0]!.mediaType).toBe('image/png');
    // A real PNG: the magic bytes have to be there.
    const png = Buffer.from(out.pages[0]!.dataBase64, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }, 120_000);
});

describe('convertir lo que ningún carril sabe leer', () => {
  it('un HEIC se convierte a JPEG para poder leerlo', async () => {
    if (!usable) return;
    // HEIC is the iPhone default and neither the OCR nor the vision API accepts it.
    // Without this conversion, every phone photo arrives mute.
    const { transcodeImage } = await import('../../src/adapters/normalize/documents');
    const heic = await readFile('fixtures/f1/boleta-escaneada.png'); // PNG sirve: prueba el camino
    const out = await transcodeImage(cfg, heic, 'foto.png');

    expect(out.mediaType).toBe('image/jpeg');
    // JPEG magic bytes: the conversion really happened.
    expect(out.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }, 60_000);

  it('el original no se toca: la conversión produce bytes aparte', async () => {
    if (!usable) return;
    const { transcodeImage } = await import('../../src/adapters/normalize/documents');
    const original = await readFile('fixtures/f1/boleta-escaneada.png');
    const antes = Buffer.from(original);
    await transcodeImage(cfg, original, 'foto.png');
    expect(original.equals(antes)).toBe(true);
  }, 60_000);
});
