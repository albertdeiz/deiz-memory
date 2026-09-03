import { describe, expect, it } from 'vitest';
import { chunkText, contextualize, TARGET_CHARS } from '../../src/core/recall/chunk.js';

describe('trocear', () => {
  it('un texto corto es un solo trozo', () => {
    expect(chunkText('el mecánico es Juan')).toEqual([{ seq: 0, content: 'el mecánico es Juan' }]);
  });

  it('un texto vacío no da trozos', () => {
    for (const t of ['', '   ', '\n\n']) expect(chunkText(t)).toEqual([]);
  });

  it('corta por párrafos antes que por longitud', () => {
    // Un documento ya trae su estructura; cortar cada N caracteres a ciegas
    // parte tablas por la mitad.
    const p = 'x'.repeat(500);
    const trozos = chunkText([p, p, p].join('\n\n'));
    expect(trozos.length).toBeGreaterThan(1);
    // Ningún trozo parte un párrafo que cabía entero.
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
    // Un "ok." suelto al final no debería ser su propio trozo: no se parece a
    // ninguna pregunta y solo ensucia los resultados.
    const trozos = chunkText(`${'w'.repeat(800)}\n\nok.`);
    expect(trozos.every((t) => t.content.length > 10)).toBe(true);
  });
});

describe('qué se embebe', () => {
  it('solo el trozo, sin anteponerle el título', () => {
    // Si los ochenta trozos de una póliza empiezan con "póliza de auto BCI",
    // los ochenta se parecen entre sí y ninguno destaca al preguntar por el
    // deducible. El contexto compartido no distingue nada.
    expect(contextualize('el deducible es de 5 UF')).toBe('el deducible es de 5 UF');
  });
});
