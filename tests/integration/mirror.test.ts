import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, planMirror, mirrorOwner, setHidden } from '../../src/core/index';
import { startStack, type TestStack } from '../helpers/stack';

let s: TestStack;
const mine = () => ({ ownerId: s.ownerId });
const theirs = () => ({ ownerId: s.otherOwnerId });
const unwrap = <T>(r: any): T => {
  if (!r.ok) throw new Error(`esperaba ok, vino ${r.kind}: ${r.message}`);
  return r.value as T;
};

/** Captura un archivo y le fija título, fecha del hecho y dominio. */
async function file(
  actor: { ownerId: string },
  opts: { title?: string; occurred?: string; domain?: string; bytes?: string; name?: string },
): Promise<string> {
  const r: any = await capture(s.deps, actor, {
    bytes: Buffer.from(opts.bytes ?? `contenido ${Math.random()}`),
    filename: opts.name ?? 'x.txt',
    title: opts.title ?? null,
  });
  const id = r.value.id;
  if (opts.occurred) {
    await s.deps.db.query('update memories set occurred_at = $2 where id = $1', [id, opts.occurred]);
  }
  if (opts.domain) {
    const d = await s.deps.db.query<{ id: string }>(
      'select id from domains where owner_id = $1 and label = $2',
      [actor.ownerId, opts.domain],
    );
    if (d.rows[0]) {
      await s.deps.db.query('update memories set domain_id = $2 where id = $1', [id, d.rows[0].id]);
    }
  }
  return id;
}

const paths = async (actor = mine()): Promise<string[]> =>
  unwrap<{ path: string }[]>(await planMirror(s.deps, actor)).map((e) => e.path);

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); });
afterAll(async () => { await s.close(); });

describe('el espejo se nombra para que lo lea una persona', () => {
  it('agrupa por dominio y ordena por cuándo pasó el hecho', async () => {
    await file(mine(), { title: 'Póliza', domain: 'Seguros', occurred: '2026-07-29' });
    await file(mine(), { title: 'Licencia', domain: 'Documentos', occurred: '2025-10-27' });

    // La licencia es más vieja como hecho aunque se guardó después: §3.3 dice que
    // la línea de tiempo que importa es cuándo pasó.
    expect(await paths()).toEqual([
      'Documentos/2025-10-27 · Licencia.txt',
      'Seguros/2026-07-29 · Póliza.txt',
    ]);
  });

  it('sin dominio ni título igual tiene un lugar', async () => {
    await file(mine(), { occurred: '2026-01-02', name: 'IMG_20260102_1032.jpg' });
    // El nombre de cámara es ruido (filenames.ts), así que no sirve de título.
    // La extensión sale del media type real del blob, no del nombre que traía.
    expect(await paths()).toEqual(['Sin categoría/2026-01-02 · Sin título.jpg']);
  });

  it('una barra en el título no crea una carpeta', async () => {
    // El fallo silencioso: el archivo aterriza donde nadie lo busca.
    await file(mine(), { title: 'Cartola 03/2026', domain: 'Finanzas', occurred: '2026-03-31' });
    const [p] = await paths();
    expect(p).toBe('Finanzas/2026-03-31 · Cartola 03-2026.txt');
    expect(p!.split('/')).toHaveLength(2);
  });

  it('dos documentos iguales no se pisan: el segundo lleva su id', async () => {
    await file(mine(), { title: 'Cartola', domain: 'Finanzas', occurred: '2026-03-31', bytes: 'a' });
    await file(mine(), { title: 'Cartola', domain: 'Finanzas', occurred: '2026-03-31', bytes: 'b' });

    const ps = await paths();
    expect(ps).toHaveLength(2);
    // Perder un documento por un nombre repetido sería silencioso; el short id
    // es el mismo que acepta `dm show`.
    expect(new Set(ps).size).toBe(2);
    expect(ps.some((p) => /\([0-9a-f]{8}\)\.txt$/.test(p))).toBe(true);
  });
});

describe('el espejo es derivado, y respeta lo que no debe verse', () => {
  it('una memoria oculta no aparece', async () => {
    const id = await file(mine(), { title: 'Algo', domain: 'Seguros', occurred: '2026-02-02' });
    expect(await paths()).toHaveLength(1);

    // Una carpeta es el lugar más visible que hay: `hidden` tiene que llegar acá.
    unwrap(await setHidden(s.deps, mine(), id, true));
    expect(await paths()).toEqual([]);
  });

  it('una nota sin archivo no produce nada', async () => {
    await capture(s.deps, mine(), { text: 'solo una nota', title: 'Nota' });
    expect(await paths()).toEqual([]);
  });

  it('no se lleva nada del otro dueño', async () => {
    await file(mine(), { title: 'Mío', domain: 'Seguros', occurred: '2026-01-01' });
    await file(theirs(), { title: 'Ajeno', domain: 'Seguros', occurred: '2026-01-01' });

    expect(await paths(mine())).toEqual(['Seguros/2026-01-01 · Mío.txt']);
    expect(await paths(theirs())).toEqual(['Seguros/2026-01-01 · Ajeno.txt']);
  });

  it('escribe el contenido real de cada blob', async () => {
    await file(mine(), { title: 'Uno', domain: 'Seguros', occurred: '2026-01-01', bytes: 'el contenido' });

    const written = new Map<string, Buffer>();
    const r = unwrap<{ files: number; bytes: number }>(
      await mirrorOwner(s.deps, mine(), { async file(p, b) { written.set(p, b); } }),
    );

    expect(r.files).toBe(1);
    expect(written.get('Seguros/2026-01-01 · Uno.txt')?.toString()).toBe('el contenido');
  });
});
