import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveDomain, capture, createDomain, editDomain, findDomain,
  listDomains, list, mergeDomains, slugify,
} from '../../src/core/index';
import type { Actor } from '../../src/core/domain/types';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * §9: los dominios son data, no un enum. Lo que se prueba acá es que agregar
 * una categoría no requiera un deploy, y que las dos operaciones honestas
 * —archivar y fusionar— dejen las memorias donde deben.
 */
let s: TestStack;
let actor: Actor;

beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s.close(); });
beforeEach(async () => {
  await s.reset();
  actor = { ownerId: s.ownerId };
});

const crear = async (label: string, desc: string) => {
  const r = await createDomain(s.deps.db, actor, { label, description: desc, confirm: true });
  if (!r.ok) throw new Error(`no creó: ${r.message}`);
  return r.value;
};

describe('slug', () => {
  it('sirve para escribirlo en un comando', () => {
    expect(slugify('Migración')).toBe('migracion');
    expect(slugify('Salud y Bienestar')).toBe('salud-y-bienestar');
    expect(slugify('  Ñuñoa!!  ')).toBe('nunoa');
  });
});

describe('crear', () => {
  it('exige descripción, porque la descripción es el prompt', async () => {
    const r = await createDomain(s.deps.db, actor, { label: 'Varios', description: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('descripción');
  });

  it('avisa cuando se solapa con una que ya existe', async () => {
    // El modo de falla de §9 es la proliferación: cuarenta dominios con la
    // mitad solapados. El bot propone, nunca crea solo.
    await crear('Consultorio', 'Consultas médicas, recetas y exámenes de laboratorio');
    const r = await createDomain(s.deps.db, actor, {
      label: 'Médico',
      description: 'Consultas médicas, recetas y exámenes clínicos',
    });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'requires_confirmation') throw new Error('esperaba confirmación');
    expect(r.affects[0]!.label).toBe('Consultorio');
  });

  it('pero deja crear igual si insistes', async () => {
    await crear('Consultorio', 'Consultas médicas, recetas y exámenes de laboratorio');
    const r = await createDomain(s.deps.db, actor, {
      label: 'Médico', description: 'Consultas médicas, recetas y exámenes clínicos', confirm: true,
    });
    expect(r.ok).toBe(true);
  });

  it('no crea dos veces el mismo slug', async () => {
    await crear('Migración', 'Visas, RUT y permanencia definitiva');
    const r = await createDomain(s.deps.db, actor, {
      label: 'migracion', description: 'otra cosa distinta por completo', confirm: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('conflict');
  });
});

describe('renombrar no rompe nada', () => {
  it('el slug NO cambia al renombrar: la identidad es el id', async () => {
    // §9: renombrar "vehículo" a "auto" cambia un label; ninguna memoria se
    // entera, y el comando que la persona ya tiene en la cabeza sigue sirviendo.
    const d = await crear('Motocicleta', 'Patente de moto, revisión y permiso de circulación');
    const r = await editDomain(s.deps.db, actor, 'motocicleta', { label: 'Moto' });
    if (!r.ok) throw new Error('no editó');
    expect(r.value.label).toBe('Moto');
    expect(r.value.slug).toBe('motocicleta');
    expect(r.value.id).toBe(d.id);
  });

  it('se encuentra por slug, por label y por alias', async () => {
    await createDomain(s.deps.db, actor, {
      label: 'Migración', description: 'Visas y RUT', aliases: ['visa', 'pdi'], confirm: true,
    });
    for (const ref of ['migracion', 'Migración', 'visa', 'PDI']) {
      expect((await findDomain(s.deps.db, actor, ref))?.slug).toBe('migracion');
    }
  });
});

describe('archivar y fusionar, que son las dos operaciones honestas', () => {
  it('archivar deja las memorias donde están', async () => {
    const d = await crear('Papeles', 'Cosas sueltas de papel');
    const m = await capture(s.deps, actor, { text: 'algo' });
    if (!m.ok) throw new Error('no capturó');
    await s.deps.db.query('update memories set domain_id = $1 where id = $2', [d.id, m.value.id]);

    await archiveDomain(s.deps.db, actor, 'papeles');

    // No aparece al listar activos, pero su memoria sigue ahí y sigue siendo suya.
    expect((await listDomains(s.deps.db, actor)).map((x) => x.slug)).not.toContain('papeles');
    const enDominio = await list(s.deps, actor, { domainId: d.id });
    if (!enDominio.ok) throw new Error('no listó');
    expect(enDominio.value).toHaveLength(1);
  });

  it('fusionar mueve las memorias y archiva el origen', async () => {
    const papeles = await crear('Papeles', 'Cosas sueltas de papel');
    const docs = await crear('Carpetas', 'Carpetas físicas del escritorio');
    for (const t of ['uno', 'dos']) {
      const m = await capture(s.deps, actor, { text: t });
      if (!m.ok) throw new Error('no capturó');
      await s.deps.db.query('update memories set domain_id = $1 where id = $2', [papeles.id, m.value.id]);
    }

    const r = await mergeDomains(s.deps, actor, 'papeles', 'carpetas', { confirm: true });
    if (!r.ok) throw new Error('no fusionó');
    expect(r.value.moved).toBe(2);

    const enDocs = await list(s.deps, actor, { domainId: docs.id });
    if (!enDocs.ok) throw new Error('no listó');
    expect(enDocs.value).toHaveLength(2);
    expect((await findDomain(s.deps.db, actor, 'papeles'))?.active).toBe(false);
  });

  it('fusionar pide confirmación y dice cuántas se mueven', async () => {
    const papeles = await crear('Papeles', 'Cosas sueltas de papel');
    await crear('Carpetas', 'Carpetas físicas del escritorio');
    const m = await capture(s.deps, actor, { text: 'algo' });
    if (!m.ok) throw new Error('no capturó');
    await s.deps.db.query('update memories set domain_id = $1 where id = $2', [papeles.id, m.value.id]);

    const r = await mergeDomains(s.deps, actor, 'papeles', 'carpetas');
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'requires_confirmation') throw new Error('esperaba confirmación');
    expect(r.message).toContain('1 memoria');
  });
});

describe('listar una categoría', () => {
  it('ordena por cuándo pasó, no por cuándo lo guardaste', async () => {
    // El criterio de listo de F2, y §3.3: el tiempo es de primera clase.
    const d = await crear('Consultorio', 'Consultas y recetas del doctor');
    const viejo = await capture(s.deps, actor, {
      text: 'consulta antigua', occurredAt: new Date('2024-01-15T00:00:00Z'),
    });
    const nuevo = await capture(s.deps, actor, {
      text: 'consulta reciente', occurredAt: new Date('2026-05-20T00:00:00Z'),
    });
    if (!viejo.ok || !nuevo.ok) throw new Error('no capturó');
    // Se captura el viejo primero pero ocurrió después: si ordenara por captura,
    // saldrían al revés.
    await s.deps.db.query('update memories set domain_id = $1 where owner_id = $2', [d.id, s.ownerId]);

    const r = await list(s.deps, actor, { domainId: d.id });
    if (!r.ok) throw new Error('no listó');
    expect(r.value.map((m) => m.excerpt)).toEqual(['consulta reciente', 'consulta antigua']);
  });

  it('no ves las categorías de otro dueño', async () => {
    await createDomain(s.deps.db, { ownerId: s.otherOwnerId }, {
      label: 'Suyo', description: 'cosas de otra persona', confirm: true,
    });
    expect((await listDomains(s.deps.db, actor)).map((d) => d.slug)).not.toContain('suyo');
    expect(await findDomain(s.deps.db, actor, 'suyo')).toBeNull();
  });
});
