import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, search, show } from '../../src/core/index';
import type { Actor } from '../../src/core/domain/types';
import { documentsConverter, rasterizePdf } from '../../src/adapters/normalize/documents';
import { fakeConverter, fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * Los otros tests prueban el *router* con carriles de mentira. Este prueba el
 * carril A de verdad, contra el sidecar real y documentos reales — porque la
 * afirmación que sostiene todo el diseño de §8.1 ("markitdown no hace OCR") es
 * una afirmación sobre markitdown, y conviene que esté verificada y no supuesta.
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
    // La razón de elegir markitdown antes que un extractor de texto plano: una
    // tabla de coberturas sigue pareciendo una tabla, y eso se busca mejor.
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
    // Este es el test que justifica que exista el carril B. El sidecar corre de
    // verdad, devuelve nada de verdad, y la regla de caída se dispara sola.
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
    // Un carril caído a las once de la noche tiene que explicarse solo.
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
    // El chat de OpenAI —lo que hablan Ollama, llama.cpp y vLLM— solo acepta
    // imágenes. Sin esto, el carril de visión solo funcionaría con Anthropic.
    const bytes = await readFile('fixtures/f1/escaneo.pdf');
    const out = await rasterizePdf(cfg, bytes, { dpi: 120 });

    expect(out.totalPages).toBe(1);
    expect(out.pages).toHaveLength(1);
    expect(out.truncated).toBe(false);
    expect(out.pages[0]!.mediaType).toBe('image/png');
    // PNG de verdad: los magic bytes tienen que estar.
    const png = Buffer.from(out.pages[0]!.dataBase64, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }, 120_000);
});

describe('convertir lo que ningún carril sabe leer', () => {
  it('un HEIC se convierte a JPEG para poder leerlo', async () => {
    if (!usable) return;
    // HEIC es el formato por defecto del iPhone y no lo acepta ni el OCR ni la
    // API de visión. Sin esta conversión, cada foto del teléfono entra muda.
    const { transcodeImage } = await import('../../src/adapters/normalize/documents');
    const heic = await readFile('fixtures/f1/boleta-escaneada.png'); // PNG sirve: prueba el camino
    const out = await transcodeImage(cfg, heic, 'foto.png');

    expect(out.mediaType).toBe('image/jpeg');
    // Magic bytes de JPEG: la conversión pasó de verdad.
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
