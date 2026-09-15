import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveFactType, capture, createFactType, editFactType, extractFacts, listFacts, unreadable,
} from '../../src/core/index';
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

/**
 * El acoplamiento es de diseño —`typesForDomain` filtra por categoría— y su
 * consecuencia es la que hay que ver: un documento legible no produce ningún
 * hecho si cayó en la categoría equivocada, y eso falla en silencio.
 *
 * Pasó de verdad: dos pasajes que el clasificador mandó a `finanzas` —con razón,
 * un pasaje es un comprobante— dejaron de producir hechos porque su tipo decía
 * `vehiculo`. Nada falló; simplemente no había nada.
 */
describe('lo que ningún tipo sabe leer se puede contar', () => {
  const texto = 'Un documento con estructura de sobra para que valga la pena leerlo. '.repeat(5);

  async function enDominio(slug: string | null): Promise<void> {
    const r: any = await capture(s.deps, mine(), { text: texto, title: 'Algo' });
    const d = slug
      ? await s.deps.db.query<{ id: string }>(
          'select id from domains where owner_id = $1 and slug = $2', [s.ownerId, slug])
      : { rows: [] };
    await s.deps.db.query(
      'update memories set domain_id = $2, normalized_text = $3 where id = $1',
      [r.value.id, d.rows[0]?.id ?? null, texto],
    );
  }

  it('cuenta las que quedaron sin categoría', async () => {
    await enDominio(null);
    const u = await unreadable(s.deps.db, mine());
    expect(u.withoutDomain).toBe(1);
    expect(u.total).toBe(1);
  });

  it('cuenta las que están en una categoría sin ningún tipo', async () => {
    // `salud` existe como semilla y ningún tipo semilla apunta ahí.
    await enDominio('salud');
    const u = await unreadable(s.deps.db, mine());
    expect(u.domainsWithoutType.map((d) => d.slug)).toContain('salud');
  });

  it('una categoría que sí tiene tipo no aparece', async () => {
    await enDominio('seguros');
    const u = await unreadable(s.deps.db, mine());
    expect(u.domainsWithoutType.map((d) => d.slug)).not.toContain('seguros');
  });

  it('un tipo sin categoría cubre a todas, así que no queda ninguna huérfana', async () => {
    await enDominio('salud');
    // `domain_slug is null` significa "cualquiera", y entonces todo documento
    // tiene al menos un candidato.
    await s.deps.db.query(
      `insert into fact_types (owner_id, slug, label, description, kind, cardinality,
         domain_slug, fields, identity_field)
       values ($1,'universal','Universal','Aplica a todo.','state','one',null,'[]'::jsonb,null)`,
      [s.ownerId],
    );
    const u = await unreadable(s.deps.db, mine());
    expect(u.domainsWithoutType).toEqual([]);
  });

  it('una memoria oculta no cuenta como ilegible', async () => {
    await enDominio('salud');
    await s.deps.db.query('update memories set hidden = true where owner_id = $1', [s.ownerId]);
    expect((await unreadable(s.deps.db, mine())).total).toBe(0);
  });
});

/**
 * Los tipos se administran por canal, no por `psql`.
 *
 * Hasta acá un tipo nacía de una semilla o de una propuesta y después era
 * inalcanzable: mover su categoría o ajustar su descripción exigía abrir una
 * shell — y una regla que solo se cumple así no es una regla (§11).
 */
describe('un tipo se crea y se edita por canal', () => {
  const base = {
    label: 'Boleta de luz',
    description: 'La boleta mensual de electricidad, con el consumo y el total a pagar.',
    kind: 'period' as const,
    fields: [
      { name: 'total', kind: 'money' as const, label: 'total a pagar', aliases: ['total'] },
      { name: 'consumo', kind: 'number' as const, label: 'consumo kWh', aliases: ['consumo'] },
    ],
  };

  it('lo crea y se puede leer de vuelta', async () => {
    const r: any = await createFactType(s.deps, mine(), base);
    expect(r.ok).toBe(true);
    expect(r.value.slug).toBe('boleta_de_luz');
    // Se leía por id y findFactType resuelve slug o label: devolvía "se creó
    // pero no se pudo leer de vuelta" sobre una fila perfectamente sana.
    expect(r.value.fields).toHaveLength(2);
  });

  it('cambiar la redacción no pregunta; cambiar la categoría sí', async () => {
    await createFactType(s.deps, mine(), base);

    const suave: any = await editFactType(s.deps, mine(), 'boleta_de_luz',
      { description: 'La boleta mensual de electricidad. NO es un comprobante de pago.' });
    expect(suave.ok).toBe(true);

    // Mover el dominio decide dónde se prueba el tipo, o sea qué documentos
    // dejan de producir hechos. Eso se confirma (§13.7).
    const duro: any = await editFactType(s.deps, mine(), 'boleta_de_luz', { domainSlug: 'hogar' });
    expect(duro.ok).toBe(false);
    expect(duro.kind).toBe('requires_confirmation');

    const hecho: any = await editFactType(s.deps, mine(), 'boleta_de_luz',
      { domainSlug: 'hogar' }, { confirm: true });
    expect(hecho.value.domainSlug).toBe('hogar');
  });

  it('las validaciones son las mismas por donde entres', async () => {
    for (const [input, esperado] of [
      [{ ...base, fields: [{ name: 'x', kind: 'rut' as never, label: 'X', aliases: [] }] }, /no es un tipo de campo/],
      [{ ...base, identityField: 'noexiste' }, /no es uno de los campos/],
      [{ ...base, cardinality: 'many' as const }, /identity_field/],
      [{ ...base, kind: 'state' as const }, /superseder/],
      [{ ...base, description: 'corta' }, /descripción es el prompt/],
      [{ ...base, domainSlug: 'no-existe' }, /No existe la categoría/],
    ] as const) {
      const r: any = await createFactType(s.deps, mine(), input as never);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(esperado);
    }
  });

  it('archivar deja los hechos, solo deja de extraer', async () => {
    await defineType('many');
    const id = await ticket();
    s.deps.classifier = saying(TWO);
    await extractFacts(s.deps, mine(), id);

    const r: any = await archiveFactType(s.deps, mine(), 'pasaje_bus');
    expect(r.value.active).toBe(false);
    // Los hechos vinieron de un documento y ese documento sigue diciendo lo que
    // dice: se quedan y se siguen citando (§9).
    expect(await listFacts(s.deps.db, mine(), {})).toHaveLength(2);
  });
});
