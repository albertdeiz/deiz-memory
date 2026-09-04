import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal, capture, createDomain, listDomains, list, proposeDomains,
} from '../../src/core/index';
import type { Actor } from '../../src/core/domain/types';
import { startStack, type TestStack } from '../helpers/stack';

/**
 * Emergent domains: so you do not have to anticipate your own categories.
 *
 * With one hard rule on top: **the bot proposes, it never creates on its own.**
 * aceptar sean dos operaciones distintas no es prolijidad, es la regla escrita
 * in the shape of the code — proposing cannot write anything.
 */
let s: TestStack;
let actor: Actor;

beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s.close(); });
beforeEach(async () => {
  await s.reset();
  actor = { ownerId: s.ownerId };
  // No seeded domains, to start from a predictable base.
  await s.deps.db.query('delete from domains where owner_id = $1', [s.ownerId]);
});

/** A memory already tagged by the classifier, but with no domain. */
const conTags = async (title: string, tags: string[]) => {
  const r = await capture(s.deps, actor, { text: title, title });
  if (!r.ok) throw new Error('no capturó');
  await s.deps.db.query('update memories set tags = $2 where id = $1', [r.value.id, tags]);
  return r.value.id;
};

describe('propose', () => {
  it('no propone nada cuando no hay racimo', async () => {
    await conTags('una cosa', ['webdox']);
    await conTags('otra cosa', ['cortina']);
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok) throw new Error('falló');
    expect(r.value).toHaveLength(0);
  });

  it('propone cuando tres cosas comparten una etiqueta', async () => {
    for (const n of [1, 2, 3]) await conTags(`Wallpaper ${n}`, ['webdox', 'corporativo']);
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok) throw new Error('falló');

    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.slug).toBe('webdox');
    expect(r.value[0]!.memoryIds).toHaveLength(3);
    // Trae ejemplos para poder decidir mirando, no a ciegas.
    expect(r.value[0]!.examples.length).toBeGreaterThan(0);
  });

  it('proponer no escribe nada: es una pregunta, no una acción', async () => {
    for (const n of [1, 2, 3]) await conTags(`Wallpaper ${n}`, ['webdox']);
    await proposeDomains(s.deps, actor);
    expect(await listDomains(s.deps.db, actor)).toHaveLength(0);
  });

  it('no propone lo que ya cubre un dominio activo', async () => {
    // If a category already exists and its description covers this, proposing a
    // near-duplicate would be exactly the proliferation to avoid.
    await createDomain(s.deps.db, actor, {
      label: 'Seguros', description: 'Pólizas de auto y hogar, coberturas y deducibles', confirm: true,
    });
    for (const n of [1, 2, 3]) await conTags(`Doc ${n}`, ['polizas', 'coberturas']);

    const r = await proposeDomains(s.deps, actor);
    if (!r.ok) throw new Error('falló');
    expect(r.value.map((p) => p.slug)).not.toContain('polizas');
  });

  it('una memoria cae en un solo racimo, en el más grande', async () => {
    // Without this, two overlapping tags would propose two categories for the same
    // things and you would have to choose between duplicates.
    for (const n of [1, 2, 3, 4] as const) await conTags(`W ${n}`, ['webdox', 'corporativo']);
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok) throw new Error('falló');

    const total = r.value.reduce((n, p) => n + p.memoryIds.length, 0);
    expect(total).toBe(4);
    expect(r.value).toHaveLength(1);
  });

  it('ignora palabras que no distinguen nada', async () => {
    for (const n of [1, 2, 3]) await conTags(`Cosa ${n}`, ['imagen', 'archivo', 'prueba']);
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok) throw new Error('falló');
    expect(r.value).toHaveLength(0);
  });

  it('no mira lo que ya tiene dominio', async () => {
    const d = await createDomain(s.deps.db, actor, {
      label: 'Marca', description: 'Cosas de la empresa', confirm: true,
    });
    if (!d.ok) throw new Error('no creó');
    for (const n of [1, 2, 3]) {
      const id = await conTags(`W ${n}`, ['banner', 'linkedin']);
      await s.deps.db.query('update memories set domain_id = $2 where id = $1', [id, d.value.id]);
    }
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok) throw new Error('falló');
    expect(r.value).toHaveLength(0);
  });
});

describe('aceptar', () => {
  it('crea el dominio y mueve las memorias del racimo', async () => {
    for (const n of [1, 2, 3]) await conTags(`Wallpaper ${n}`, ['webdox']);
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok || !r.value[0]) throw new Error('sin propuesta');

    const done = await acceptProposal(s.deps, actor, r.value[0]);
    if (!done.ok) throw new Error('no aceptó');
    expect(done.value.moved).toBe(3);

    const dentro = await list(s.deps, actor, { domainId: done.value.domain.id });
    if (!dentro.ok) throw new Error('no listó');
    expect(dentro.value).toHaveLength(3);
  });

  it('deja cambiar el nombre y la descripción antes de aceptar', async () => {
    // The suggested description is a starting point: it is the classifier's prompt,
    // so being able to improve it before it takes effect matters.
    for (const n of [1, 2, 3]) await conTags(`Wallpaper ${n}`, ['webdox']);
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok || !r.value[0]) throw new Error('sin propuesta');

    const done = await acceptProposal(s.deps, actor, {
      ...r.value[0],
      label: 'Marca',
      description: 'Material corporativo: wallpapers, banners y logos',
    });
    if (!done.ok) throw new Error('no aceptó');
    expect(done.value.domain.slug).toBe('marca');
    expect(done.value.domain.description).toContain('wallpapers');
  });

  it('no pisa una memoria que ya tiene dominio', async () => {
    for (const n of [1, 2, 3]) await conTags(`W ${n}`, ['webdox']);
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok || !r.value[0]) throw new Error('sin propuesta');

    const otro = await createDomain(s.deps.db, actor, {
      label: 'Otro', description: 'algo distinto por completo', confirm: true,
    });
    if (!otro.ok) throw new Error('no creó');
    await s.deps.db.query('update memories set domain_id = $2 where id = $1',
      [r.value[0].memoryIds[0], otro.value.id]);

    const done = await acceptProposal(s.deps, actor, r.value[0]);
    if (!done.ok) throw new Error('no aceptó');
    expect(done.value.moved).toBe(2);
  });
});

describe('aislamiento', () => {
  it('no propone con memorias de otro dueño', async () => {
    const otro = { ownerId: s.otherOwnerId };
    for (const n of [1, 2, 3]) {
      const r = await capture(s.deps, otro, { text: `suyo ${n}` });
      if (!r.ok) throw new Error('no capturó');
      await s.deps.db.query('update memories set tags = $2 where id = $1', [r.value.id, ['secreto']]);
    }
    const r = await proposeDomains(s.deps, actor);
    if (!r.ok) throw new Error('falló');
    expect(r.value).toHaveLength(0);
  });
});
