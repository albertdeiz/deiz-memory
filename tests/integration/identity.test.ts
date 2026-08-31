import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  identityOwner, listIdentities, mintPairingCode, redeemPairingCode, touchIdentity,
} from '../../src/core/index.js';
import { startStack, type TestStack } from '../helpers/stack.js';

/**
 * El emparejamiento es la puerta de entrada al sistema por chat, así que lo que
 * se prueba acá no es "funciona" sino "no se puede forzar": un código no se usa
 * dos veces, no sirve vencido, y no vincula a nadie que no lo tenga.
 */
let s: TestStack;
const NOW = new Date('2026-03-14T12:00:00.000Z');

beforeAll(async () => { s = await startStack(); });
beforeEach(async () => { await s.reset(); });
afterAll(async () => { await s.close(); });

const mint = async (ownerId = s.ownerId, now = NOW) => {
  const r = await mintPairingCode(s.deps.db, ownerId, now);
  if (!r.ok) throw new Error(`no acuñó: ${r.message}`);
  return r.value;
};

describe('acuñar', () => {
  it('devuelve un código legible y con vencimiento', async () => {
    const c = await mint();
    expect(c.code).toHaveLength(8);
    // Sin caracteres que se confundan al dictarlo por teléfono.
    expect(c.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(c.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('no acuña para un dueño que no existe', async () => {
    const r = await mintPairingCode(s.deps.db, '00000000-0000-0000-0000-000000000000', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not_found');
  });
});

describe('canjear', () => {
  it('vincula la identidad al dueño del código', async () => {
    const c = await mint();
    const r = await redeemPairingCode(s.deps.db, 'telegram', '4471', c.code, NOW, 'Albert');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ownerId).toBe(s.ownerId);

    const quien = await identityOwner(s.deps.db, 'telegram', '4471');
    expect(quien?.ownerId).toBe(s.ownerId);
    expect(quien?.displayName).toBe('Albert');
  });

  it('acepta el código en minúsculas y con espacios', async () => {
    // Se copia de una terminal a un teléfono: va a llegar sucio.
    const c = await mint();
    const r = await redeemPairingCode(s.deps.db, 'telegram', '4471', `  ${c.code.toLowerCase()} `, NOW);
    expect(r.ok).toBe(true);
  });

  it('no sirve dos veces', async () => {
    // "De un solo uso" tiene que ser cierto aunque lleguen dos mensajes juntos:
    // por eso la condición vive en el UPDATE y no en un chequeo previo.
    const c = await mint();
    expect((await redeemPairingCode(s.deps.db, 'telegram', '111', c.code, NOW)).ok).toBe(true);

    const segundo = await redeemPairingCode(s.deps.db, 'telegram', '222', c.code, NOW);
    expect(segundo.ok).toBe(false);

    // Y el segundo no quedó vinculado a nada.
    expect(await identityOwner(s.deps.db, 'telegram', '222')).toBeNull();
  });

  it('no sirve vencido', async () => {
    const c = await mint(s.ownerId, NOW);
    const tarde = new Date(c.expiresAt.getTime() + 1000);
    const r = await redeemPairingCode(s.deps.db, 'telegram', '333', c.code, tarde);
    expect(r.ok).toBe(false);
    expect(await identityOwner(s.deps.db, 'telegram', '333')).toBeNull();
  });

  it('un código inventado no vincula nada', async () => {
    const r = await redeemPairingCode(s.deps.db, 'telegram', '444', 'ZZZZZZZZ', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not_found');
  });

  it('no distingue entre inexistente, usado y vencido', async () => {
    // Separarlos le diría a un extraño si un código existe. Los tres se
    // arreglan igual: pide otro.
    const usado = await mint();
    await redeemPairingCode(s.deps.db, 'telegram', '111', usado.code, NOW);
    const vencido = await mint();
    const tarde = new Date(vencido.expiresAt.getTime() + 1000);

    const mensajes = [
      await redeemPairingCode(s.deps.db, 'telegram', 'a', 'ZZZZZZZZ', NOW),
      await redeemPairingCode(s.deps.db, 'telegram', 'b', usado.code, NOW),
      await redeemPairingCode(s.deps.db, 'telegram', 'c', vencido.code, tarde),
    ].map((r) => (r.ok ? 'ok' : r.message));

    expect(new Set(mensajes).size).toBe(1);
  });
});

describe('identidad', () => {
  it('un desconocido no tiene dueño, y sin dueño no hay Actor', async () => {
    // Esta es la propiedad estructural que sostiene la regla dura 9: sin Actor
    // no existe el camino para llamar a ninguna operación del core.
    expect(await identityOwner(s.deps.db, 'telegram', 'nadie')).toBeNull();
  });

  it('el mismo dueño puede tener varios canales', async () => {
    for (const [canal, id] of [['telegram', '1'], ['whatsapp', '2']] as const) {
      const c = await mint();
      await redeemPairingCode(s.deps.db, canal, id, c.code, NOW);
    }
    const ids = await listIdentities(s.deps.db, s.ownerId);
    expect(ids.map((i) => i.channel).sort()).toEqual(['telegram', 'whatsapp']);
  });

  it('lista solo las de un dueño', async () => {
    const mia = await mint(s.ownerId);
    await redeemPairingCode(s.deps.db, 'telegram', 'mia', mia.code, NOW);
    const suya = await mint(s.otherOwnerId);
    await redeemPairingCode(s.deps.db, 'telegram', 'suya', suya.code, NOW);

    const ids = await listIdentities(s.deps.db, s.ownerId);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.externalUserId).toBe('mia');
  });

  it('registra actividad sin tocar el vínculo', async () => {
    const c = await mint();
    await redeemPairingCode(s.deps.db, 'telegram', '4471', c.code, NOW);
    const luego = new Date(NOW.getTime() + 60_000);
    await touchIdentity(s.deps.db, 'telegram', '4471', luego);

    const ids = await listIdentities(s.deps.db, s.ownerId);
    expect(ids[0]!.lastSeenAt?.getTime()).toBe(luego.getTime());
    expect(ids[0]!.ownerId).toBe(s.ownerId);
  });
});
