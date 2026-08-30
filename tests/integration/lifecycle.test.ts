import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, list, purge, show, storageKey } from '../../src/core/index.js';
import { startStack, type TestStack } from '../helpers/stack.js';

let s: TestStack;
const mine = () => ({ ownerId: s.ownerId });
const theirs = () => ({ ownerId: s.otherOwnerId });
const unwrap = <T>(r: any): T => {
  if (!r.ok) throw new Error(`esperaba ok, vino ${r.kind}: ${r.message}`);
  return r.value as T;
};
const auditRows = async () =>
  (await s.deps.db.query<{ action: string; subject_id: string; detail: any }>(
    'select action, subject_id, detail from audit_log order by at',
  )).rows;

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); });
afterAll(async () => { await s.close(); });

describe('purge', () => {
  it('sin confirmar no borra nada y explica qué se llevaría', async () => {
    const r: any = await capture(s.deps, mine(), { text: 'algo importante', title: 'La póliza' });
    const attempt = await purge(s.deps, mine(), r.value.shortId, { confirm: false });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok && attempt.kind === 'requires_confirmation') {
      expect(attempt.affects).toEqual([{ kind: 'memory', id: r.value.id, label: 'La póliza' }]);
      expect(attempt.message).toContain('dm hide');
    } else {
      throw new Error('esperaba requires_confirmation');
    }

    expect(unwrap<any[]>(await list(s.deps, mine()))).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('confirmado borra la memoria, su blob huérfano, y deja rastro en auditoría', async () => {
    const bytes = await readFile('fixtures/poliza.pdf');
    const r: any = await capture(s.deps, mine(), { bytes, filename: 'poliza.pdf' });
    const key = storageKey(r.value.sha256);
    expect(await s.deps.blobs.exists(key)).toBe(true);

    const done = unwrap<any>(await purge(s.deps, mine(), r.value.shortId, { confirm: true }));
    expect(done.blobDeleted).toBe(true);

    expect(unwrap<any[]>(await list(s.deps, mine()))).toEqual([]);
    expect((await s.deps.db.query('select 1 from blobs')).rowCount).toBe(0);
    expect(await s.deps.blobs.exists(key)).toBe(false);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('purge');
    expect(audit[0]!.subject_id).toBe(r.value.id);
    expect(audit[0]!.detail.filename).toBe('poliza.pdf');
    expect(audit[0]!.detail.blobDeleted).toBe(true);
  });

  it('si otra memoria comparte el blob, el archivo NO se borra', async () => {
    const bytes = await readFile('fixtures/poliza.pdf');
    const a: any = await capture(s.deps, mine(), { bytes, filename: 'poliza.pdf' });
    const b: any = await capture(s.deps, mine(), { bytes, filename: 'copia.pdf' });
    const key = storageKey(a.value.sha256);

    const done = unwrap<any>(await purge(s.deps, mine(), a.value.shortId, { confirm: true }));
    expect(done.blobDeleted).toBe(false);
    expect(await s.deps.blobs.exists(key)).toBe(true);
    expect((await s.deps.db.query('select 1 from blobs')).rowCount).toBe(1);

    // La que quedó sigue sirviendo su archivo.
    expect(unwrap<any>(await show(s.deps, mine(), b.value.shortId)).sha256).toBe(a.value.sha256);
  });

  it('purgar la última referencia sí se lleva el archivo', async () => {
    const bytes = await readFile('fixtures/poliza.pdf');
    const a: any = await capture(s.deps, mine(), { bytes, filename: 'a.pdf' });
    const b: any = await capture(s.deps, mine(), { bytes, filename: 'b.pdf' });
    const key = storageKey(a.value.sha256);

    await purge(s.deps, mine(), a.value.shortId, { confirm: true });
    const second = unwrap<any>(await purge(s.deps, mine(), b.value.shortId, { confirm: true }));

    expect(second.blobDeleted).toBe(true);
    expect(await s.deps.blobs.exists(key)).toBe(false);
    expect(await auditRows()).toHaveLength(2);
  });

  it('nadie purga memorias ajenas', async () => {
    const r: any = await capture(s.deps, theirs(), { text: 'suyo' });
    const attempt = await purge(s.deps, mine(), r.value.shortId, { confirm: true });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.kind).toBe('not_found');
    expect(unwrap<any[]>(await list(s.deps, theirs()))).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('purgar una memoria oculta funciona: ocultar no es un candado', async () => {
    const r: any = await capture(s.deps, mine(), { text: 'algo' });
    await s.deps.db.query('update memories set hidden = true where id = $1', [r.value.id]);
    const done = unwrap<any>(await purge(s.deps, mine(), r.value.shortId, { confirm: true }));
    expect(done.shortId).toBe(r.value.shortId);
  });
});
