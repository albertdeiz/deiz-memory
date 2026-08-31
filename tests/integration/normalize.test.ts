import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, reprocess, search, show } from '../../src/core/index.js';
import type { Actor } from '../../src/core/domain/types.js';
import { fakeConverter, fakeConverters } from '../helpers/converters.js';
import { startStack, type TestStack } from '../helpers/stack.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Un PDF de verdad, mínimo pero válido: %PDF- es lo que mira detectMediaType. */
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
    // El carril más barato y el único que no puede faltar nunca.
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
    // La regla de §8.1 en una línea: markitdown no hace OCR, así que un PDF sin
    // capa de texto devuelve vacío y hay que mirar el papel.
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
    // Un PDF escaneado y sin visión configurada: lo honesto es guardar lo que
    // hay, decir por qué está incompleto, y quedar esperando el reproceso.
    stack.deps.converters = fakeConverters({ document: fakeConverter('vacío') });

    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'escaneo.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizationError).toContain('vision');
    expect(detail.value.normalizedText).toBe('vacío');
    // needs_review y no normalized: el estado tiene que decir que esto necesita
    // una mirada. Antes de la 005 se quedaba con el estado anterior y una
    // memoria sin texto podía figurar como normalizada.
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
    // El modo de falla que la migración 003 existe para evitar: la primera
    // transcripción se comía lo que habías escrito al mandar la foto.
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
    // "Listo cuando: mandas la foto de una boleta y la encuentras buscando por
    // lo que dice." El nombre del archivo es ruido de cámara a propósito.
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

describe('reprocesar (UC-15)', () => {
  it('vuelve a leer el original y mejora el texto cuando mejora el carril', async () => {
    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:sin API key') });
    const res = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'receta.jpg' });
    if (!res.ok) throw new Error('no capturó');

    const antes = await show(stack.deps, actor, res.value.id);
    if (!antes.ok) throw new Error('no mostró');
    expect(antes.value.normalizationError).toContain('sin API key');

    // Aparece la key. El blob nunca se tocó, así que se puede reprocesar entero.
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
    // Regla dura 9: sin excepciones y sin modo admin.
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
    // Si reprocesar pudiera empeorar el resultado, nadie reprocesaría nunca su
    // histórico — y ahí "todo lo derivado es regenerable" deja de ser una red.
    stack.deps.converters = fakeConverters({ vision: fakeConverter('Amoxicilina 500mg cada 8 horas por 7 días. ' + LARGO) });
    const res = await capture(stack.deps, actor, { bytes: jpegBytes, filename: 'receta.jpg' });
    if (!res.ok) throw new Error('no capturó');

    stack.deps.converters = fakeConverters({ vision: fakeConverter('throw:la API está caída') });
    await reprocess(stack.deps, actor, { ref: res.value.id });

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizedText).toContain('Amoxicilina');
    // Pero el fallo sí queda anotado: se conserva el dato y se dice la verdad.
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
    // de documentos, y sin guarda esos 30 caracteres pisan la transcripción.
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
    // Quedarse con la transcripción pero marcarla `none` sería mentir sobre su
    // origen, y dm reprocess --lane vision ya no la encontraría.
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
    // "No hay nada que reprocesar" sería peor que un error: te irías tranquilo
    // creyendo que está todo bien.
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
    // El caso real: una boleta chica leída perfecto por OCR son ~80 caracteres,
    // menos que el umbral de "pobre" —que existe para detectar PDF sin capa de
    // texto, no para juzgar boletas—. Sin la regla, quedaba marcada con "el
    // carril document no está configurado", que además de falso manda a mirar
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
    // Acá el fallo sí explica el resultado: markitdown corrió, no trajo nada, y
    // el carril que podía salvarlo no estaba.
    stack.deps.converters = fakeConverters({ document: fakeConverter('') });
    const res = await capture(stack.deps, actor, { bytes: pdfBytes, filename: 'escaneo.pdf' });
    if (!res.ok) throw new Error('no capturó');

    const detail = await show(stack.deps, actor, res.value.id);
    if (!detail.ok) throw new Error('no mostró');
    expect(detail.value.normalizationError).toContain('vision');
  });
});
