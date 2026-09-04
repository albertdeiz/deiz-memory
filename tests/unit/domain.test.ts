import { describe, expect, it } from 'vitest';
import { excerptOf, shortId } from '../../src/core/domain/types';
import { storageKey } from '../../src/core/ops/rows';

describe('shortId', () => {
  it('toma los primeros 8 hex, sin guiones', () => {
    expect(shortId('3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5061')).toBe('3f2a1b4c');
  });
});

describe('excerptOf', () => {
  it('colapsa espacios y recorta con puntos suspensivos', () => {
    expect(excerptOf('el   mecánico\n\nes Juan')).toBe('el mecánico es Juan');
    expect(excerptOf('a'.repeat(200))!.length).toBe(160);
    expect(excerptOf('a'.repeat(200))!.endsWith('…')).toBe(true);
  });
  it('devuelve null cuando no hay nada', () => {
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf('   ')).toBeNull();
  });
});

describe('storageKey', () => {
  it('reparte por prefijo para no dejar un directorio plano gigante', () => {
    const sha = 'ab' + 'cd' + 'e'.repeat(60);
    expect(storageKey(sha)).toBe(`blobs/ab/cd/${sha}`);
  });
});
