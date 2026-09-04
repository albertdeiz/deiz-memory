import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, createDomain, reprocess, search, show } from '../../src/core/index';
import type { Actor } from '../../src/core/domain/types';
import { fakeConverter, fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A real PDF, minimal but valid: the signature is what media detection looks at. */
const pdfBytes = Buffer.from('%PDF-1.4\n% un pdf de mentira pero con la firma correcta\n');
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

const LARGO = 'Póliza 12345678 de auto, deducible 5 UF, asistencia 600 600 6000. '.repeat(4);

let stack: TestStack;
let actor: Actor;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.reset();
  actor = { ownerId: stack.ownerId };
  stack.deps.converters = fakeConverters();
});

describe('carriles', () => {
  it('lee un archivo de texto sin ninguna herramienta', async () => {
    // The cheapest lane and the only one that can never be missing.
    const res = await capture(stack.deps, actor, {
      bytes: Buffer.from('el mecánico de confianza es Juan, +56 9 1234 5678'),
      filename: 'notas.txt',
    });
    expect(res.ok).toBe(true);

    const detail = await show(stack.deps, actor, (res as { value: { id: string } }).value.id);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.lane).toBe('text');
    expect(detail.value.normalizedText).toContain('Juan');
    expect(detail.value.normalizationError).toBeNull();
    expect(detail.value.status).toBe('normalized');
  });

  it('usa markitdown para un docx', async () => {
    const doc = fakeConverter('# Carta\n\n' + LARGO);
    stack.deps.converters = fakeConverters({ document: doc });

    const res = await capture(stack.deps, actor, { bytes: Buffer.from('PK\x03\x04zip'), filename: 'carta.docx' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('document');
    expect(doc.calls[0]!.mediaType).toBe(DOCX);
    expect(detail.value.normalizedText).toContain('Carta');
  });

  it('cae de markitdown a visión cuando el PDF viene escaneado', async () => {
    // The rule in one line: the document lane does no OCR, so a PDF with no text
    // layer comes back empty and the paper has to be looked at.
    const doc = fakeConverter('');
    const vision = fakeConverter(LARGO);
    stack.deps.converters = fakeConverters({ document: doc, vision });

    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'poliza.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(doc.calls).toHaveLength(1);
    expect(vision.calls).toHaveLength(1);
    expect(detail.value.lane).toBe('vision');
    expect(detail.value.normalizedText).toContain('12345678');
    expect(detail.value.normalizationError).toBeNull();
  });

  it('no paga el carril de visión cuando markitdown ya trajo el texto', async () => {
    const doc = fakeConverter(LARGO);
    const vision = fakeConverter('esto no debería correr nunca');
    stack.deps.converters = fakeConverters({ document: doc, vision });

    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'poliza.pdf' });
    if (!res.ok) throw new Error('no capturó');

    expect(doc.calls).toHaveLength(1);
    expect(vision.calls).toHaveLength(0);
  });

  it('deja anotado el carril que faltaba, sin perder lo poco que sacó', async () => {
    // A scanned PDF with no visual lane configured: the honest move is to store what
    // there is, say why it is incomplete, and wait for a reprocess.
    stack.deps.converters = fakeConverters({ document: fakeConverter('vacío') });

    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'escaneo.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizationError).toContain('vision');
    expect(detail.value.normalizedText).toBe('vacío');
    // needs_review and not normalized: the status has to say this needs a look.
    // It used to keep the previous status, and a memory with no text could read as
    // normalized.
    expect(detail.value.status).toBe('needs_review');
  });

  it('anota el fallo del carril sin reventar la captura', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó la API') });

    const res = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'boleta.jpg' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizationError).toContain('se cayó la API');
  });

  it('no promete texto de un formato sin carril', async () => {
    const res = await capture(stack.deps, actor, {
      bytes: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]),
      filename: 'clip.mp4',
    });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('none');
    expect(detail.value.normalizationError).toBeNull();
  });
});

describe('la nota y lo extraído no se pisan', () => {
  it('conserva tu nota después de transcribir el archivo', async () => {
    // The failure mode the note/text split exists to prevent: the first transcript
    // used to eat what you wrote when you sent the photo.
    stack.deps.converters = fakeConverters({ vision: fakeConverter(LARGO) });

    const res = await capture(stack.deps, actor, {
      bytes: jpegBytes,
      filename: 'boleta.jpg',
      text: 'la boleta del taller de la Rosita',
    });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.note).toBe('la boleta del taller de la Rosita');
    expect(detail.value.normalizedText).toContain('Póliza');
  });

  it('una memoria de solo texto guarda tu nota y no finge haber extraído nada', async () => {
    const res = await capture(stack.deps, actor, { text: 'el corredor es Pedro, +569 8765 4321' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.note).toContain('Pedro');
    expect(detail.value.normalizedText).toBeNull();
    expect(detail.value.lane).toBe('none');
  });
});

describe('el criterio de F1', () => {
  it('encuentra una foto por lo que dice, no por cómo se llama', async () => {
    // The real criterion: send a photo of a receipt and find it by what it says.
    // The filename is camera noise on purpose.
    stack.deps.converters = fakeConverters({
      vision: fakeConverter('BOLETA · Ferretería El Roble · amoladora Bosch · $89.990 · 14/03/2026'),
    });

    await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'IMG_20260314_093312.jpg' });

    const hit = await search(stack.deps, actor, { query: 'amoladora' });
    if (!hit.ok) throw new Error('no buscó');
    expect(hit.value).toHaveLength(1);
    expect(hit.value[0]!.originalFilename).toBe('IMG_20260314_093312.jpg');
  });

  it('busca sin tildes sobre lo transcrito, igual que sobre lo escrito', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('Póliza de vehículo, revisión técnica al día') });
    await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'foto.jpg' });

    const hit = await search(stack.deps, actor, { query: 'vehiculo' });
    if (!hit.ok) throw new Error('no buscó');
    expect(hit.value).toHaveLength(1);
  });

  it('la nota también es buscable', async () => {
    await capture(stack.deps, actor, { text: 'el mecánico se llama Juan Pérez' });
    const hit = await search(stack.deps, actor, { query: 'mecanico' });
    if (!hit.ok) throw new Error('no buscó');
    expect(hit.value).toHaveLength(1);
  });
});

describe('reprocesar desde el original', () => {
  it('vuelve a leer el original y mejora el texto cuando mejora el carril', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:sin API key') });
    const res = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'receta.jpg' });
    if (!res.ok) throw new Error('no capturó');

    const antes = await show(stack.deps, actor, res.value.id);
    if (!antes.ok) throw new Error('no mostró');
    expect(antes.value.normalizationError).toContain('sin API key');

    // The key appears. The blob was never touched, so it can be reprocessed whole.
    stack.deps.converters = fakeConverters({ vision: fakeConverter('Paracetamol 500mg cada 8 horas') });
    const done = await reprocess(stack.deps, actor, { ref: res.value.id });
    expect(done.ok).toBe(true);

    const despues = await show(stack.deps, actor, res.value.id);
    if (!despues.ok) throw new Error('no mostró');
    expect(despues.value.normalizedText).toContain('Paracetamol');
    expect(despues.value.normalizationError).toBeNull();
  });

  it('reprocesar no toca la nota', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('primera lectura ' + LARGO) });
    const res = await capture(stack.deps, actor, {
      bytes: jpegBytes, filename: 'receta.jpg', text: 'la del doctor Soto',
    });
    if (!res.ok) throw new Error('no capturó');

    stack.deps.converters = fakeConverters({ vision: fakeConverter('segunda lectura ' + LARGO) });
    await reprocess(stack.deps, actor, { ref: res.value.id });

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.note).toBe('la del doctor Soto');
    expect(detail.value.normalizedText).toContain('segunda lectura');
  });

  it('selecciona solo las fallidas', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó') });
    await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'a.jpg' });
    await capture(stack.deps, actor, { bytes: Buffer.from('texto sano y suficientemente largo para no ser pobre ' + LARGO), filename: 'b.txt' });

    const res = await reprocess(stack.deps, actor, { failed: true, confirm: true });
    if (!res.ok) throw new Error('no reprocesó');
    expect(res.value.queued).toBe(1);
  });

  it('en lote pide confirmación, porque el carril de visión se paga', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó') });
    await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'a.jpg' });
    await capture(stack.deps, actor, { bytes: Buffer.concat([jpegBytes, Buffer.from('x')]), filename: 'b.jpg' });

    const res = await reprocess(stack.deps, actor, { failed: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('requires_confirmation');
  });

  it('exige decir qué reprocesar', async () => {
    const res = await reprocess(stack.deps, actor, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('invalid');
  });

  it('no reprocesa memorias de otro dueño', async () => {
    // Owner isolation: no exceptions and no admin mode.
    stack.deps.converters = fakeConverters({ vision: fakeConverter('secreto ajeno') });
    const suya = await capture(stack.deps, { ownerId: stack.otherOwnerId }, { bytes: jpegBytes, filename: 'x.jpg' });
    if (!suya.ok) throw new Error('no capturó');

    const res = await reprocess(stack.deps, actor, { ref: suya.value.id });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('not_found');
  });
});

describe('reprocesar nunca deja las cosas peor', () => {
  it('un carril caído no borra la transcripción que ya tenías', async () => {
    // If reprocessing could make the result worse, nobody would ever reprocess their
    // history — and there "everything derived is regenerable" stops being a net.
    stack.deps.converters = fakeConverters({ vision: fakeConverter('Amoxicilina 500mg cada 8 horas por 7 días. ' + LARGO) });
    const res = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'receta.jpg' });
    if (!res.ok) throw new Error('no capturó');

    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:la API está caída') });
    await reprocess(stack.deps, actor, { ref: res.value.id });

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizedText).toContain('Amoxicilina');
    // The failure is still recorded: the datum is kept and the truth is told.
    expect(detail.value.normalizationError).toContain('la API está caída');
  });

  it('una corrida buena sí reemplaza a la anterior', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('lectura vieja y borrosa ' + LARGO) });
    const res = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'receta.jpg' });
    if (!res.ok) throw new Error('no capturó');

    stack.deps.converters = fakeConverters({ vision: fakeConverter('lectura nueva y nítida ' + LARGO) });
    await reprocess(stack.deps, actor, { ref: res.value.id });

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizedText).toContain('nueva y nítida');
    expect(detail.value.normalizedText).not.toContain('vieja y borrosa');
  });
});

describe('una corrida fallida no degrada lo que ya había', () => {
  it('no reemplaza una transcripción buena por la basura de otro carril', async () => {
    // El caso real: la key vence, el reproceso saca 30 caracteres por el carril
    // lane, and with no guard those 30 characters overwrite the transcript.
    stack.deps.converters = fakeConverters({ vision: fakeConverter('Amoxicilina 500mg cada 8 horas. ' + LARGO) });
    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'receta.pdf' });
    if (!res.ok) throw new Error('no capturó');
    const bueno = await show(stack.deps, actor, res.value.id);
    if (!bueno.ok || !bueno.value.normalizedText) throw new Error('no quedó texto bueno');

    stack.deps.converters = fakeConverters({
      document: fakeConverter('\f \f basura de 30 chars'),
      vision: fakeConverter('throw:API key vencida'),
    });
    await reprocess(stack.deps, actor, { ref: res.value.id });

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizedText).toContain('Amoxicilina');
    expect(detail.value.normalizedText).not.toContain('basura');
  });

  it('conserva también de qué carril salió el texto que conservó', async () => {
    // Keeping the transcript but marking it as no lane would lie about its origin,
    // and a lane-filtered reprocess could no longer find it.
    stack.deps.converters = fakeConverters({ vision: fakeConverter('transcripción buena ' + LARGO) });
    const res = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'receta.jpg' });
    if (!res.ok) throw new Error('no capturó');

    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:API caída') });
    await reprocess(stack.deps, actor, { ref: res.value.id });

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.lane).toBe('vision');
    expect(detail.value.normalizationError).toContain('API caída');

    const otra = await reprocess(stack.deps, actor, { lane: 'vision', confirm: true });
    if (!otra.ok) throw new Error('no seleccionó');
    expect(otra.value.queued).toBe(1);
  });
});

describe('los selectores de reprocess', () => {
  it('rechaza las combinaciones que no pueden dar nada', async () => {
    // "Nothing to reprocess" would be worse than an error: you would walk away
    // believing everything is fine.
    for (const input of [{ pending: true, lane: 'vision' as const }, { pending: true, failed: true }]) {
      const res = await reprocess(stack.deps, actor, input);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe('invalid');
    }
  });

  it('un límite basura cae al default en vez de reventar en Postgres', async () => {
    const res = await reprocess(stack.deps, actor, { all: true, limit: Number('abc'), confirm: true });
    expect(res.ok).toBe(true);
  });

  it('devuelve uuid completos donde promete uuid', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter(LARGO) });
    const cap = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'a.jpg' });
    if (!cap.ok) throw new Error('no capturó');

    const res = await reprocess(stack.deps, actor, { ref: cap.value.id });
    if (!res.ok) throw new Error('no reprocesó');
    expect(res.value.ids[0]).toBe(cap.value.id);
    expect(res.value.shortIds[0]).toHaveLength(8);
  });
});

describe('un fallo previo no explica un resultado posterior', () => {
  it('no marca error si un carril posterior sí leyó, aunque el texto sea corto', async () => {
    // The real case: a small receipt read perfectly by OCR is about 80 characters,
    // below the "poor" threshold — which exists to detect PDFs with no text layer,
    // not to judge receipts. Without the rule it stayed flagged as a lane not being
    // configured, which is both false and sends you looking in the wrong place.
    // el lugar equivocado.
    stack.deps.converters = fakeConverters({ vision: fakeConverter('Boleta 88213 · Total $89.990') });
    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'boleta.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizedText).toContain('88213');
    expect(detail.value.normalizationError).toBeNull();
    expect(detail.value.lane).toBe('vision');
  });

  it('pero sí marca error si el carril que faltaba era el último', async () => {
    // Here the failure does explain the result: the document lane ran, brought back
    // nothing, and the lane that could have saved it was absent.
    stack.deps.converters = fakeConverters({ document: fakeConverter('') });
    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'escaneo.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizationError).toContain('vision');
  });
});

/**
 * Classification is part of the pipeline, not a separate command.
 *
 * For a whole phase it was not: the classifier existed and worked, but only the
 * manual command ever called it. Fifteen documents arrived through chat and
 * stayed normalized, indexed and uncategorized, with the health check green.
 * The work was considered done because the command ran.
 */
describe('clasificar es parte de guardar', () => {
  const fakeClassifier = (domain: string | null) => ({
    async classify() {
      return { domain, title: 'Póliza de auto', occurredAt: null, confidence: 0.9, tags: [] };
    },
    async complete() { return ''; },
    async available() { return { ok: true, detail: 'fake' }; },
  });

  beforeEach(async () => {
    await createDomain(stack.deps.db, actor, { label: 'Seguros', description: 'pólizas y coberturas' });
    await createDomain(stack.deps.db, actor, { label: 'Hogar', description: 'garantías y técnicos' });
  });

  /** The slug of the category that ended up set, or null. */
  const categoria = async (id: string): Promise<string | null> => {
    const { rows } = await stack.deps.db.query<{ slug: string }>(
      `select d.slug from memories m join domains d on d.id = m.domain_id where m.id = $1`, [id]);
    return rows[0]?.slug ?? null;
  };

  it('una memoria que entra sale con categoría, sin que nadie corra un comando', async () => {
    stack.deps.classifier = fakeClassifier('seguros');
    const res = await capture(stack.deps, actor, {
      bytes: Buffer.from(LARGO), filename: 'poliza.txt',
    });
    if (!res.ok) throw new Error('no capturó');

    expect(await categoria(res.value.id)).toBe('seguros');
    const d = await show(stack.deps, actor, res.value.id);
    if (!d.ok) throw new Error('no existe');
    expect(d.value.title).toBe('Póliza de auto');
    expect(d.value.status).toBe('classified');
  });

  it('una nota suelta también se clasifica, aunque no tenga archivo', async () => {
    // Leaving early on "there is no blob" had already kept notes out of the index
    // once. The same path cannot leave them uncategorized.
    stack.deps.classifier = fakeClassifier('hogar');
    const res = await capture(stack.deps, actor, { text: 'el gásfiter es Juan, +56 9 1234 5678' });
    if (!res.ok) throw new Error('no capturó');

    expect(await categoria(res.value.id)).toBe('hogar');
  });

  it('reprocesar NO pisa la categoría que ya tenía', async () => {
    // Reprocessing improves the text; it does not revisit decisions already made.
    // Reclassifying on purpose is its own command.
    stack.deps.classifier = fakeClassifier('seguros');
    const res = await capture(stack.deps, actor, {
      bytes: Buffer.from(LARGO), filename: 'poliza.txt',
    });
    if (!res.ok) throw new Error('no capturó');

    stack.deps.classifier = fakeClassifier('hogar');
    await reprocess(stack.deps, actor, { ref: res.value.id, confirm: true });

    expect(await categoria(res.value.id)).toBe('seguros');
  });

  it('sin clasificador se guarda igual, solo que sin categoría', async () => {
    // Capture is never blocked by a service being down.
    stack.deps.classifier = null;
    const res = await capture(stack.deps, actor, {
      bytes: Buffer.from(LARGO), filename: 'poliza.txt',
    });
    if (!res.ok) throw new Error('no capturó');

    expect(await categoria(res.value.id)).toBeNull();
    const d = await show(stack.deps, actor, res.value.id);
    if (!d.ok) throw new Error('no existe');
    expect(d.value.normalizedText).toContain('Póliza');
  });
});
