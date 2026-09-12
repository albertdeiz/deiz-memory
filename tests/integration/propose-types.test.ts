import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptFactType, capture, listFactTypes, proposeFactTypes, type TypeProposal } from '../../src/core/index';
import type { Classifier } from '../../src/core/ports';
import { startStack, type TestStack } from '../helpers/stack';

let s: TestStack;
const mine = () => ({ ownerId: s.ownerId });
const unwrap = <T>(r: any): T => {
  if (!r.ok) throw new Error(`esperaba ok, vino ${r.kind}: ${r.message}`);
  return r.value as T;
};

/** El documento que motiva la propuesta. Los valores de abajo salen de acá. */
const DOC = [
  'REPÚBLICA DE CHILE · SERVICIO DE REGISTRO CIVIL',
  'CERTIFICADO DE ANTECEDENTES',
  'Nombre: ALBERTO DIAZ OLIVAR',
  'RUN: 26.574.025-1',
  'Fecha de emisión: 09/01/2026',
  'Válido hasta: 09/04/2026',
  'No registra anotaciones prontuariales.',
].join('\n') + '\n' + 'relleno del documento para pasar el largo mínimo. '.repeat(10);

/** Un clasificador que devuelve exactamente lo que el test quiere probar. */
const saying = (payload: unknown): Classifier => ({
  async classify() { return payload; },
  async complete() { return ''; },
  async available() { return { ok: true, detail: 'fake' }; },
});

const base = {
  vale_la_pena: true,
  slug: 'certificado_antecedentes',
  label: 'Certificado de antecedentes',
  description: 'El certificado de antecedentes que emite el Registro Civil, con su vigencia.',
  kind: 'state',
  identity_field: 'run',
  valid_from_field: 'fecha_emision',
  valid_until_field: 'valido_hasta',
  campos: [
    { name: 'run', label: 'RUN', kind: 'text', aliases: ['run', 'rut'], ejemplo: '26.574.025-1' },
    { name: 'nombre', label: 'Nombre', kind: 'text', aliases: ['nombre'], ejemplo: 'ALBERTO DIAZ OLIVAR' },
    { name: 'fecha_emision', label: 'Emisión', kind: 'date', aliases: ['emision'], ejemplo: '09/01/2026' },
    { name: 'valido_hasta', label: 'Válido hasta', kind: 'date', aliases: ['vence'], ejemplo: '09/04/2026' },
  ],
};

async function orphan(): Promise<void> {
  const r: any = await capture(s.deps, mine(), { text: DOC, title: 'Certificado de Antecedentes' });
  const d = await s.deps.db.query<{ id: string }>(
    `select id from domains where owner_id = $1 and slug = 'documentos'`, [s.ownerId],
  );
  await s.deps.db.query(
    'update memories set domain_id = $2, normalized_text = $3 where id = $1',
    [r.value.id, d.rows[0]!.id, DOC],
  );
}

const propose = async (payload: unknown): Promise<TypeProposal[]> => {
  s.deps.classifier = saying(payload);
  return unwrap<TypeProposal[]>(await proposeFactTypes(s.deps, mine()));
};

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); await orphan(); });
afterAll(async () => { s.deps.classifier = null; await s.close(); });

describe('los tipos se proponen desde lo que nadie sabe leer', () => {
  it('propone un tipo con sus campos y su identidad', async () => {
    const [p] = await propose(base);
    expect(p?.slug).toBe('certificado_antecedentes');
    expect(p?.kind).toBe('state');
    expect(p?.identityField).toBe('run');
    expect(p?.validUntilField).toBe('valido_hasta');
    expect(p?.fields.map((f) => f.name)).toEqual(['run', 'nombre', 'fecha_emision', 'valido_hasta']);
  });

  it('no propone nada para un documento sin datos duros', async () => {
    expect(await propose({ vale_la_pena: false })).toEqual([]);
  });

  it('no propone un tipo que ya existe', async () => {
    const [p] = await propose(base);
    unwrap(await acceptFactType(s.deps, mine(), p!, { confirm: true }));
    // Proponer de nuevo lo mismo sería el modo de falla de §9: proliferación.
    expect(await propose(base)).toEqual([]);
  });
});

describe('lo que el modelo propone se verifica contra el documento', () => {
  it('descarta un campo cuyo ejemplo no está en el texto', async () => {
    const [p] = await propose({
      ...base,
      campos: [...base.campos, { name: 'inventado', label: 'X', kind: 'text', aliases: [], ejemplo: 'NO ESTÁ' }],
    });
    expect(p?.fields.map((f) => f.name)).not.toContain('inventado');
    expect(p?.discarded).toContain('inventado');
  });

  it('rechaza las meta-claves del esquema como si fueran campos', async () => {
    // Medido: el modelo metió identity_field y valid_until_field DENTRO de campos.
    // Pasaban grounding —una fecha es una fecha— y habrían quedado como columnas
    // llamadas como la cosa que debía apuntar a una columna.
    const [p] = await propose({
      ...base,
      campos: [
        ...base.campos,
        { name: 'identity_field', label: 'Identity', kind: 'text', aliases: [], ejemplo: '26.574.025-1' },
        { name: 'valid_until_field', label: 'Hasta', kind: 'date', aliases: [], ejemplo: '09/04/2026' },
      ],
    });
    expect(p?.fields.map((f) => f.name)).toEqual(['run', 'nombre', 'fecha_emision', 'valido_hasta']);
  });

  it('colapsa campos que traen el mismo valor', async () => {
    // Es el modelo leyendo una tabla hacia abajo: una licencia propuso clase,
    // actual y proximo, los tres "A1". Un dato con tres nombres es peor que uno.
    const [p] = await propose({
      ...base,
      campos: [
        base.campos[0], base.campos[1],
        { name: 'clase', label: 'Clase', kind: 'text', aliases: [], ejemplo: 'ALBERTO DIAZ OLIVAR' },
      ],
    });
    expect(p?.fields.map((f) => f.name)).toEqual(['run', 'nombre']);
    expect(p?.discarded.join(' ')).toContain('repetido');
  });

  it('un tipo estado sin identidad no se ofrece', async () => {
    // Sin identidad nunca podría superseder, que es la razón entera de `state`.
    expect(await propose({ ...base, identity_field: null })).toEqual([]);
  });

  it('un tipo con menos de dos campos usables no vale la fila', async () => {
    expect(await propose({ ...base, campos: [base.campos[0]] })).toEqual([]);
  });
});

describe('aceptar es una decisión tuya, no del sistema', () => {
  it('sin confirmar no crea nada y dice qué se crearía', async () => {
    const [p] = await propose(base);
    const attempt: any = await acceptFactType(s.deps, mine(), p!, { confirm: false });

    expect(attempt.ok).toBe(false);
    expect(attempt.kind).toBe('requires_confirmation');
    expect(attempt.affects[0].label).toBe('Certificado de antecedentes');
    expect(await listFactTypes(s.deps.db, mine())).toHaveLength(2); // solo las semillas
  });

  it('confirmado deja el tipo listo para extraer', async () => {
    const [p] = await propose(base);
    unwrap(await acceptFactType(s.deps, mine(), p!, { confirm: true }));

    const types = await listFactTypes(s.deps.db, mine());
    const nuevo = types.find((t) => t.slug === 'certificado_antecedentes')!;
    expect(nuevo.domainSlug).toBe('documentos');
    expect(nuevo.identityField).toBe('run');
    // El ejemplo servía para juzgar la propuesta; no es parte del tipo.
    expect(JSON.stringify(nuevo.fields)).not.toContain('ejemplo');
    expect(JSON.stringify(nuevo.fields)).not.toContain('example');
  });
});
