import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, list, search, setHidden, show } from '../../src/core/index';
import { startStack, type TestStack } from '../helpers/stack';

let s: TestStack;
const mine = () => ({ ownerId: s.ownerId });
const theirs = () => ({ ownerId: s.otherOwnerId });
const unwrap = <T>(r: any): T => {
  if (!r.ok) throw new Error(`esperaba ok, vino ${r.kind}: ${r.message}`);
  return r.value as T;
};
const ids = (rows: any[]) => rows.map((m) => m.shortId);

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); });
afterAll(async () => { await s.close(); });

describe('search', () => {
  it('ignora tildes en los dos sentidos', async () => {
    await capture(s.deps, mine(), { text: 'el mecánico de Ñuñoa' });
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'mecanico' }))).toHaveLength(1);
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'mecánico' }))).toHaveLength(1);
  });

  it('aplica stemming español: singular encuentra plural y al revés', async () => {
    await capture(s.deps, mine(), { text: 'me recetaron paracetamol' });
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'receta' }))).toHaveLength(1);
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'recetas' }))).toHaveLength(1);
  });

  it('busca en el título y en el nombre del archivo, no solo en el cuerpo', async () => {
    const bytes = await readFile('fixtures/poliza.pdf');
    await capture(s.deps, mine(), { bytes, filename: 'poliza.pdf', title: 'Seguro del auto' });
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'seguro' }))).toHaveLength(1);
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'poliza' }))).toHaveLength(1);
  });

  it('entiende la sintaxis de websearch: frases y exclusión', async () => {
    await capture(s.deps, mine(), { text: 'consulta con el doctor Perez por la rodilla' });
    await capture(s.deps, mine(), { text: 'consulta con el dentista' });
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'consulta -dentista' }))).toHaveLength(1);
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: '"doctor Perez"' }))).toHaveLength(1);
  });

  it('sin resultados devuelve lista vacía, no un error', async () => {
    const r = await search(s.deps, mine(), { query: 'helicoptero' });
    expect(r.ok).toBe(true);
    expect(unwrap<any[]>(r)).toEqual([]);
  });

  it('rechaza una búsqueda vacía', async () => {
    const r = await search(s.deps, mine(), { query: '   ' });
    expect(r.ok).toBe(false);
  });
});

describe('aislamiento por dueño (regla dura 9)', () => {
  it('list nunca devuelve memorias ajenas', async () => {
    await capture(s.deps, mine(), { text: 'mi receta médica' });
    await capture(s.deps, theirs(), { text: 'su receta médica' });

    expect(unwrap<any[]>(await list(s.deps, mine()))).toHaveLength(1);
    expect(unwrap<any[]>(await list(s.deps, theirs()))).toHaveLength(1);
  });

  it('search nunca cruza dueños, ni con el mismo texto exacto', async () => {
    await capture(s.deps, theirs(), { text: 'diagnóstico confidencial' });
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'diagnostico' }))).toEqual([]);
  });

  it('un id ajeno es not_found, no forbidden: decir "existe" ya filtra información', async () => {
    const r: any = await capture(s.deps, theirs(), { text: 'algo suyo' });
    const attempt = await show(s.deps, mine(), r.value.shortId);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.kind).toBe('not_found');
  });
});

describe('ocultar', () => {
  it('saca de list y de search sin destruir', async () => {
    const r: any = await capture(s.deps, mine(), { text: 'clave del router' });
    await setHidden(s.deps, mine(), r.value.shortId, true);

    expect(unwrap<any[]>(await list(s.deps, mine()))).toEqual([]);
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'router' }))).toEqual([]);

    expect(ids(unwrap<any[]>(await list(s.deps, mine(), { includeHidden: true })))).toContain(r.value.shortId);
    expect(unwrap<any>(await show(s.deps, mine(), r.value.shortId)).hidden).toBe(true);
  });
});

describe('resolución de id por prefijo', () => {
  it('acepta el prefijo corto y el uuid completo', async () => {
    const r: any = await capture(s.deps, mine(), { text: 'algo' });
    expect(unwrap<any>(await show(s.deps, mine(), r.value.shortId)).id).toBe(r.value.id);
    expect(unwrap<any>(await show(s.deps, mine(), r.value.id)).id).toBe(r.value.id);
  });

  it('un prefijo que no existe es not_found', async () => {
    const r = await show(s.deps, mine(), 'deadbeef');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not_found');
  });

  it('un prefijo que matchea a varias es ambiguous, no una elección al azar', async () => {
    // Ids controlados que comparten prefijo: provocar la colisión al azar exigiría
    // decenas de miles de filas y haría el test lento y no determinista.
    const a = 'abcd1234-0000-4000-8000-000000000001';
    const b = 'abcd1234-0000-4000-8000-000000000002';
    for (const id of [a, b]) {
      await s.deps.db.query(
        `insert into memories (id, owner_id, source, normalized_text) values ($1, $2, 'cli', $3)`,
        [id, s.ownerId, `nota ${id}`],
      );
    }

    const r = await show(s.deps, mine(), 'abcd1234');
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === 'ambiguous') {
      expect((r.detail as { matches: string[] }).matches).toHaveLength(2);
    } else {
      throw new Error('se esperaba un prefijo ambiguo');
    }

    // Con suficientes caracteres deja de ser ambiguo.
    expect(unwrap<any>(await show(s.deps, mine(), 'abcd1234-0000-4000-8000-000000000001')).id).toBe(a);
  });

  it('rechaza un prefijo demasiado corto en vez de adivinar', async () => {
    const r = await show(s.deps, mine(), 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('invalid');
  });
});

describe('el nombre del archivo pesa menos que el contenido', () => {
  it('una coincidencia en el contenido le gana a una en el nombre', async () => {
    // El nombre dice "poliza" pero no es de lo que trata; el otro sí lo es.
    await capture(s.deps, mine(), { bytes: Buffer.from('nada que ver'), filename: 'poliza.txt' });
    await capture(s.deps, mine(), { text: 'la póliza del auto cubre el parabrisas' });

    const hits = unwrap<any[]>(await search(s.deps, mine(), { query: 'poliza' }));
    expect(hits).toHaveLength(2);
    expect(hits[0]!.excerpt).toContain('parabrisas');
  });

  it('el título le gana al contenido', async () => {
    await capture(s.deps, mine(), { text: 'mencioné el dentista de pasada' });
    await capture(s.deps, mine(), { text: 'otra cosa', title: 'Dentista' });

    const hits = unwrap<any[]>(await search(s.deps, mine(), { query: 'dentista' }));
    expect(hits[0]!.title).toBe('Dentista');
  });

  it('un nombre de cámara sigue siendo buscable, pero no encabeza', async () => {
    await capture(s.deps, mine(), { bytes: Buffer.from('x'), filename: 'IMG_20260114_093312.jpg' });
    expect(unwrap<any[]>(await search(s.deps, mine(), { query: 'img' }))).toHaveLength(1);
  });
});
