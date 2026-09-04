import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, fetchBlob, list, show, storageKey } from '../../src/core/index';
import { startStack, type TestStack } from '../helpers/stack';

let s: TestStack;
const actor = () => ({ ownerId: s.ownerId });
const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): T => {
  if (!r.ok) throw new Error(`esperaba ok, vino ${r.kind}: ${r.message}`);
  return r.value as T;
};

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); });
afterAll(async () => { await s.close(); });

describe('capture', () => {
  it('guarda texto suelto sin crear ningún blob', async () => {
    const r = unwrap<any>(await capture(s.deps, actor(), { text: 'el mecánico es Juan' }) as any);
    expect(r.sha256).toBeNull();
    expect(r.shortId).toHaveLength(8);

    const detail = unwrap<any>(await show(s.deps, actor(), r.shortId) as any);
    // What you write lives in the note column and not in the extracted text: that
    // field is only for what derives from the file, which does get regenerated.
    expect(detail.note).toBe('el mecánico es Juan');
    expect(detail.normalizedText).toBeNull();
    expect(detail.status).toBe('normalized');
  });

  it('el mismo archivo dos veces: un blob, dos memorias', async () => {
    const bytes = await readFile('fixtures/poliza.pdf');
    const a = unwrap<any>(await capture(s.deps, actor(), { bytes, filename: 'poliza.pdf' }) as any);
    const b = unwrap<any>(await capture(s.deps, actor(), { bytes, filename: 'copia.pdf' }) as any);

    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(a.sha256).toBe(b.sha256);
    expect(a.id).not.toBe(b.id);

    const blobs = await s.deps.db.query('select sha256 from blobs');
    expect(blobs.rowCount).toBe(1);
    const memories = unwrap<any[]>(await list(s.deps, actor()) as any);
    expect(memories).toHaveLength(2);
  });

  it('detecta el tipo por los bytes, no por el nombre', async () => {
    const bytes = await readFile('fixtures/boleta.jpg');
    const r = unwrap<any>(await capture(s.deps, actor(), { bytes, filename: 'factura.pdf' }) as any);
    expect(r.mediaType).toBe('image/jpeg');
  });

  it('indexa el contenido de un archivo de texto: leerlo no es normalizarlo', async () => {
    const bytes = await readFile('fixtures/notas.txt');
    const r = unwrap<any>(await capture(s.deps, actor(), { bytes, filename: 'notas.txt' }) as any);
    const detail = unwrap<any>(await show(s.deps, actor(), r.shortId) as any);
    expect(detail.normalizedText).toContain('paracetamol');
  });

  it('devuelve los bytes originales intactos', async () => {
    const bytes = await readFile('fixtures/carta.docx');
    const r = unwrap<any>(await capture(s.deps, actor(), { bytes, filename: 'carta.docx' }) as any);
    const blob = unwrap<any>(await fetchBlob(s.deps, actor(), r.shortId) as any);
    expect(blob.bytes.equals(bytes)).toBe(true);
    expect(await s.deps.blobs.exists(storageKey(r.sha256))).toBe(true);
  });

  it('rechaza una captura vacía en vez de guardar basura', async () => {
    const r = await capture(s.deps, actor(), { text: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('invalid');
  });

  it('rechaza a un actor que no existe', async () => {
    const r = await capture(s.deps, { ownerId: '00000000-0000-0000-0000-000000000000' }, { text: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('forbidden');
  });

  it('guarda la fecha del hecho aparte de la de captura', async () => {
    const occurredAt = new Date('2026-01-15T00:00:00Z');
    const r = unwrap<any>(await capture(s.deps, actor(), { text: 'query', occurredAt }) as any);
    const detail = unwrap<any>(await show(s.deps, actor(), r.shortId) as any);
    expect(detail.occurredAt?.toISOString()).toBe(occurredAt.toISOString());
    expect(detail.capturedAt.toISOString()).toBe('2026-03-14T12:00:00.000Z');
  });
});
