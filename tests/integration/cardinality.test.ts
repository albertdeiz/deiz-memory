import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, extractFacts, listFacts } from '../../src/core/index';
import { validateCardinality } from '../../src/core/facts/registry';
import type { Classifier } from '../../src/core/ports';
import { startStack, type TestStack } from '../helpers/stack';

let s: TestStack;
const mine = () => ({ ownerId: s.ownerId });

/** Un PDF de dos pasajes, como los reales: dos pasajeros en un documento. */
const DOC = [
  'N° DE RESERVA: PB1789413498',
  'EMPRESA: Buses Jans',
  '',
  'PASAJERO: ALBERTO DIAZ',
  'RUT / Pasaporte / DNI: 26.574.025-1',
  'No ASIENTO: 5 (Salón Cama)',
  '',
  'PASAJERO: EMILY MACHADO',
  'RUT / Pasaporte / DNI: 29.024.781-0',
  'No ASIENTO: 4 (Salón Cama)',
  '',
  'Bajada: Terminal Sur - Nicasio Retamales 044',
].join('\n');

const saying = (payload: unknown): Classifier => ({
  async classify() { return payload; },
  async complete() { return ''; },
  async available() { return { ok: true, detail: 'fake' }; },
});

const FIELDS = [
  { name: 'pasajero', kind: 'text', label: 'pasajero', aliases: ['pasajero'] },
  { name: 'rut', kind: 'text', label: 'RUT', aliases: ['rut'] },
  { name: 'asiento', kind: 'text', label: 'asiento', aliases: ['asiento'], near: ['asiento'] },
];

async function defineType(cardinality: 'one' | 'many', identity: string | null = 'rut'): Promise<void> {
  await s.deps.db.query(
    `insert into fact_types (owner_id, slug, label, description, kind, cardinality,
       domain_slug, fields, identity_field)
     values ($1,'pasaje_bus','Pasaje','Un pasaje de bus. Un documento puede traer varios.',
             'period',$2,'vehiculo',$3::jsonb,$4)
     on conflict (owner_id, slug) do update set cardinality = $2, identity_field = $4`,
    [s.ownerId, cardinality, JSON.stringify(FIELDS), identity],
  );
}

async function ticket(): Promise<string> {
  const r: any = await capture(s.deps, mine(), { text: DOC, title: 'Pasajes' });
  const d = await s.deps.db.query<{ id: string }>(
    `select id from domains where owner_id = $1 and slug = 'vehiculo'`, [s.ownerId],
  );
  await s.deps.db.query(
    'update memories set domain_id = $2, normalized_text = $3 where id = $1',
    [r.value.id, d.rows[0]!.id, DOC],
  );
  return r.value.id;
}

const TWO = {
  aplica: true,
  campos: [
    { pasajero: 'ALBERTO DIAZ', rut: '26.574.025-1', asiento: '5' },
    { pasajero: 'EMILY MACHADO', rut: '29.024.781-0', asiento: '4' },
  ],
};

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); });
afterAll(async () => { s.deps.classifier = null; await s.close(); });

describe('un documento puede traer varias instancias', () => {
  it('guarda un hecho por pasajero, no uno que pisa al otro', async () => {
    await defineType('many');
    const id = await ticket();
    s.deps.classifier = saying(TWO);

    const out: any = await extractFacts(s.deps, mine(), id);
    expect(out.value.extracted).toEqual(['pasaje_bus ×2']);

    const facts = await listFacts(s.deps.db, mine(), {});
    expect(facts.map((f) => f.payload.pasajero).sort())
      .toEqual(['ALBERTO DIAZ', 'EMILY MACHADO']);
    // Cada fila se distingue por su identidad, que es para lo que existe.
    expect(facts.map((f) => f.identity).sort()).toEqual(['26.574.025-1', '29.024.781-0']);
  });

  it('un tipo `one` se queda con uno aunque el modelo mande dos', async () => {
    await defineType('one');
    const id = await ticket();
    s.deps.classifier = saying(TWO);

    await extractFacts(s.deps, mine(), id);
    expect(await listFacts(s.deps.db, mine(), {})).toHaveLength(1);
  });

  it('re-extraer no duplica: actualiza cada fila por su identidad', async () => {
    await defineType('many');
    const id = await ticket();
    s.deps.classifier = saying(TWO);

    await extractFacts(s.deps, mine(), id);
    await extractFacts(s.deps, mine(), id);
    expect(await listFacts(s.deps.db, mine(), {})).toHaveLength(2);
  });

  it('dos filas con la misma identidad son una fila dicha dos veces', async () => {
    await defineType('many');
    const id = await ticket();
    s.deps.classifier = saying({
      aplica: true,
      campos: [TWO.campos[0], TWO.campos[0]],
    });

    await extractFacts(s.deps, mine(), id);
    expect(await listFacts(s.deps.db, mine(), {})).toHaveLength(1);
  });

  it('una fila sin respaldo no se lleva a la otra', async () => {
    await defineType('many');
    const id = await ticket();
    s.deps.classifier = saying({
      aplica: true,
      campos: [
        TWO.campos[0],
        { pasajero: 'NO ESTA EN EL DOCUMENTO', rut: '11.111.111-1', asiento: '9' },
      ],
    });

    await extractFacts(s.deps, mine(), id);
    const facts = await listFacts(s.deps.db, mine(), {});
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload.pasajero).toBe('ALBERTO DIAZ');
  });
});

describe('las dos filas del mismo documento no se superan entre sí', () => {
  it('coexisten, porque la supersesión ya llaveaba por identidad', async () => {
    await defineType('many');
    const id = await ticket();
    s.deps.classifier = saying(TWO);

    await extractFacts(s.deps, mine(), id);
    const facts = await listFacts(s.deps.db, mine(), { includeSuperseded: true });
    expect(facts.every((f) => f.supersededBy === null)).toBe(true);
  });
});

describe('un tipo many sin identidad no puede funcionar', () => {
  it('se rechaza al definirlo, no al extraer', () => {
    // Sin identidad las dos filas son indistinguibles y el upsert las colapsa:
    // el segundo dato desaparece sin que nada falle.
    expect(validateCardinality({ cardinality: 'many', identityField: null })).toMatch(/identity_field/);
    expect(validateCardinality({ cardinality: 'many', identityField: 'rut' })).toBeNull();
    expect(validateCardinality({ cardinality: 'one', identityField: null })).toBeNull();
  });
});
