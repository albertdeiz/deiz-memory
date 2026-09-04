import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, countReview, listReview, reprocess, show } from '../../src/core/index';
import { PermanentError } from '../../src/core/result';
import type { Actor } from '../../src/core/domain/types';
import type { Converter } from '../../src/core/ports';
import { fakeConverter, fakeConverters } from '../helpers/converters';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * The review inbox. What is tested is not that it lists, but that it **says what
 * to do**: an inbox that enumerates problems without distinguishing which a
 * retry fixes leaves you no better off than opening a SQL client.
 */
let s: TestStack;
let actor: Actor;

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const otro = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);

/** A lane that fails permanently: it cannot read that format. */
const permanente = (msg: string): Converter => ({
  async extract() { throw new PermanentError(msg); },
  async available() { return { ok: true, detail: 'fake' }; },
});

beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s.close(); });
beforeEach(async () => {
  await s.reset();
  actor = { ownerId: s.ownerId };
  s.deps.converters = fakeConverters();
});

describe('qué entra a la bandeja', () => {
  it('lo que salió bien no entra', async () => {
    s.deps.converters = fakeConverters({ vision: fakeConverter('texto largo y suficiente. '.repeat(10)) });
    await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg' });

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value).toHaveLength(0);
  });

  it('lo que falló entra, con el motivo', async () => {
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó la API') });
    await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg' });

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.error).toContain('se cayó la API');
  });

  it('lo que quedó incompleto también, aunque tenga texto', async () => {
    // A low-confidence OCR is not a failure: it is something you stored anyway and
    // should look at. The inbox has to see it.
    const dudoso: Converter = {
      async extract() {
        return { text: 'algo borroso', incomplete: 'el OCR quedó con poca confianza' };
      },
      async available() { return { ok: true, detail: 'fake' }; },
    };
    s.deps.converters = fakeConverters({ vision: dudoso });
    await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg' });

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.chars).toBeGreaterThan(0);
  });
});

describe('reintentar sirve o no sirve', () => {
  it('un fallo transitorio se marca como reintentable', async () => {
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:la API está caída') });
    await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg' });

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value[0]!.retryable).toBe(true);
  });

  it('un formato que el carril no sabe leer, no', async () => {
    // The HEIC case: retrying tomorrow gives exactly the same.
    s.deps.converters = fakeConverters({ vision: permanente('no acepta image/heic') });
    await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg' });

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value[0]!.retryable).toBe(false);
  });

  it('con un carril transitorio y otro permanente, gana reintentar', async () => {
    // Equivocarse hacia "reintenta" cuesta una corrida; hacia "no insistas"
    // hides a memory forever.
    s.deps.converters = fakeConverters({
      document: fakeConverter('throw:servicio apagado'),
      vision: permanente('formato no soportado'),
    });
    await capture(s.deps, actor, { bytes: Buffer.from('%PDF-1.4\nx'), filename: 'a.pdf' });

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value[0]!.retryable).toBe(true);
  });

  it('el conteo separa lo que se puede arreglar de lo que no', async () => {
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:caída transitoria') });
    await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg' });
    s.deps.converters = fakeConverters({ vision: permanente('formato no soportado') });
    await capture(s.deps, actor, { bytes: otro, filename: 'b.jpg' });

    const c = await countReview(s.deps.db, actor);
    expect(c).toEqual({ total: 2, retryable: 1, needMore: 1 });
  });
});

describe('el estado dice la verdad', () => {
  it('una memoria que falló queda en needs_review, no en normalized', async () => {
    // The bug this fixed: the status was set to normalized when a note existed, the
    // note later moved columns, and a failed run did not touch the status. Memories
    // with not one letter extracted read as normalized.
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó') });
    const res = await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg', text: 'mi nota' });
    if (!res.ok) throw new Error('no capturó');

    const d = await show(s.deps, actor, res.value.id);
    if (!d.ok) throw new Error('no mostró');
    expect(d.value.status).toBe('needs_review');
  });

  it('y vuelve a normalized cuando el reproceso funciona', async () => {
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó') });
    const res = await capture(s.deps, actor, { bytes: jpeg, filename: 'a.jpg' });
    if (!res.ok) throw new Error('no capturó');

    s.deps.converters = fakeConverters({ vision: fakeConverter('ya se puede leer. '.repeat(10)) });
    await reprocess(s.deps, actor, { ref: res.value.id });

    const d = await show(s.deps, actor, res.value.id);
    if (!d.ok) throw new Error('no mostró');
    expect(d.value.status).toBe('normalized');

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value).toHaveLength(0);
  });
});

describe('aislamiento', () => {
  it('no ves la bandeja de otro dueño', async () => {
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó') });
    await capture(s.deps, { ownerId: s.otherOwnerId }, { bytes: jpeg, filename: 'suya.jpg' });

    const r = await listReview(s.deps, actor);
    if (!r.ok) throw new Error('no listó');
    expect(r.value).toHaveLength(0);
    expect((await countReview(s.deps.db, actor)).total).toBe(0);
  });
});

describe('la confirmación de reprocess nombra lo afectado', () => {
  it('lista las memorias en vez de decir "3 memorias"', async () => {
    // Purge already did this; reprocess said a number and nothing else.
    s.deps.converters = fakeConverters({ vision: fakeConverter('throw:se cayó') });
    await capture(s.deps, actor, { bytes: jpeg, filename: 'primera.jpg', title: 'Primera' });
    await capture(s.deps, actor, { bytes: otro, filename: 'segunda.jpg', title: 'Segunda' });

    const r = await reprocess(s.deps, actor, { failed: true });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'requires_confirmation') throw new Error('esperaba confirmación');
    expect(r.affects.map((a) => a.label).sort()).toEqual(['Primera', 'Segunda']);
  });
});
