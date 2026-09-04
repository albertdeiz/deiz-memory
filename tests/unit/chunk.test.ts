import { describe, expect, it } from 'vitest';
import { chunkText, contextualize, TARGET_CHARS } from '../../src/core/recall/chunk';

describe('trocear', () => {
  it('un texto corto es un solo trozo', () => {
    expect(chunkText('el mecánico es Juan')).toEqual([{ seq: 0, content: 'el mecánico es Juan' }]);
  });

  it('un texto vacío no da trozos', () => {
    for (const t of ['', '   ', '\n\n']) expect(chunkText(t)).toEqual([]);
  });

  it('corta por párrafos antes que por longitud', () => {
    // A document already carries its structure; cutting blindly every N characters
    // parte tablas por la mitad.
    const p = 'x'.repeat(500);
    const trozos = chunkText([p, p, p].join('\n\n'));
    expect(trozos.length).toBeGreaterThan(1);
    // No chunk splits a paragraph that fitted whole.
    for (const t of trozos) expect(t.content).not.toMatch(/^x{499}$/);
  });

  it('parte un párrafo que por sí solo no cabe', () => {
    const trozos = chunkText('y'.repeat(TARGET_CHARS * 3));
    expect(trozos.length).toBeGreaterThan(2);
    for (const t of trozos) expect(t.content.length).toBeLessThanOrEqual(TARGET_CHARS);
  });

  it('numera en orden, sin huecos', () => {
    const trozos = chunkText(Array.from({ length: 8 }, () => 'z'.repeat(400)).join('\n\n'));
    expect(trozos.map((t) => t.seq)).toEqual(trozos.map((_, i) => i));
  });

  it('no deja trozos residuales que no aportan', () => {
    // A stray "ok." at the end should not be its own chunk: it resembles no
    // question and only dirties the results.
    const trozos = chunkText(`${'w'.repeat(800)}\n\nok.`);
    expect(trozos.every((t) => t.content.length > 10)).toBe(true);
  });
});

describe('qué se embebe', () => {
  it('solo el trozo, sin anteponerle el título', () => {
    // If all eighty chunks of a policy start with the same title, all eighty
    // resemble each other and none stands out when asked about the
    // deducible. El contexto compartido no distingue nada.
    expect(contextualize('el deducible es de 5 UF')).toBe('el deducible es de 5 UF');
  });
});
