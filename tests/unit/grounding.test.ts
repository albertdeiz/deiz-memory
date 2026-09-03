import { describe, expect, it } from 'vitest';
import { checkGrounding, figures, normalizeNumber } from '../../src/core/recall/grounding.js';

describe('normalizar un número', () => {
  it('la coma es decimal y el punto es de miles, como en Chile', () => {
    expect(normalizeNumber('3,0')).toBe('3');
    expect(normalizeNumber('89.990')).toBe('89990');
    expect(normalizeNumber('1.234,56')).toBe('1234.56');
  });

  it('sin ceros de cola: "3,0" y "3" son el mismo dato', () => {
    expect(normalizeNumber('3,00')).toBe(normalizeNumber('3'));
  });
});

describe('cifras con su unidad', () => {
  it('la unidad se reconoce a los dos lados', () => {
    // Los documentos escriben "UF 3,0"; las personas escriben "3 UF".
    expect(figures('UF 3,0').pairs).toContain('3|uf');
    expect(figures('3 UF').pairs).toContain('3|uf');
  });

  it('pegada también cuenta', () => {
    expect(figures('AUTO BCI UF3 36M').pairs).toContain('3|uf');
  });
});

describe('respaldo de las cifras', () => {
  const poliza = ['| Sismo | CAD120160331 | UF 3,0 | DEDUCIBLE INTELIGENTE'];

  it('deja pasar la cifra que sí está, aunque esté escrita distinto', () => {
    expect(checkGrounding('El deducible es de 3 UF [a853a71c].', poliza).ok).toBe(true);
  });

  it('descarta la cifra que no está en ningún pasaje', () => {
    // El caso real: la cita era válida y el número inventado. Los ocho pasajes
    // recuperados no contenían "5 UF" en ninguna parte.
    const r = checkGrounding('El deducible es de 5 UF [a853a71c].', poliza);
    expect(r.ok).toBe(false);
    expect(r.ungrounded).toContain('5 uf');
  });

  it('los dígitos de la cita no se cuentan como datos', () => {
    // "[a853a71c]" trae 853 y 71 adentro; no son cifras de la respuesta.
    expect(checkGrounding('El deducible es de 3 UF [a853a71c].', poliza).ok).toBe(true);
  });

  it('atrapa la unidad cambiada, que es el fallo conocido de F3', () => {
    // "$89.990" redactado como "89.990 UF": número correcto, unidad inventada.
    const r = checkGrounding('El total es de 89.990 UF [x].', ['SUBTOTAL $89.990']);
    expect(r.ok).toBe(false);
    expect(r.ungrounded).toContain('89990 uf');
  });

  it('una respuesta sin cifras no tiene nada que respaldar', () => {
    expect(checkGrounding('Tu aseguradora es BCI [x].', poliza).ok).toBe(true);
  });
});
