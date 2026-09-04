import { describe, expect, it } from 'vitest';
import { coerce, grounded, normalizeDate } from '../../src/core/facts/values.js';

describe('normalizar una fecha', () => {
  it('acepta la forma chilena y la ISO, y las deja iguales', () => {
    // El PDF escribe 07/09/2026 y el modelo devuelve 2026-09-07.
    expect(normalizeDate('07/09/2026')).toBe('2026-09-07');
    expect(normalizeDate('2026-09-07')).toBe('2026-09-07');
    expect(normalizeDate('7/9/2026')).toBe('2026-09-07');
  });

  it('lo que no es fecha no lo es', () => {
    for (const x of ['agosto', '', '2026', '99/99/2026']) {
      const r = normalizeDate(x);
      expect(r === null || coerce(x, 'date') === null).toBe(true);
    }
  });
});

describe('coerce · la forma canónica', () => {
  it('los montos vuelven como número, sin separadores', () => {
    expect(coerce('$886.568', 'money')).toBe(886568);
    expect(coerce('UF 3,0', 'uf')).toBe(3);
    expect(coerce('2,56 %', 'number')).toBe(2.56);
  });

  it('una fecha imposible se descarta aunque tenga forma de fecha', () => {
    expect(coerce('31/02/2026', 'date')).toBeNull();
  });

  it('un teléfono es sus dígitos', () => {
    expect(coerce('+56 9 8765 4321', 'phone')).toBe('56987654321');
    expect(coerce('123', 'phone')).toBeNull();
  });
});

describe('grounded · que el documento lo diga', () => {
  const poliza = 'Poliza N° B-VP- 9344586-4 · Patente VHWD58 · Deducible UF 3,0 · vigencia 29-07-2026';
  const cartola = 'MONTO FACTURADO A PAGAR $886.568 — PAGAR HASTA 07/09/2026 — CUPO TOTAL $12.500.000';

  it('un monto escrito con puntos es el mismo número', () => {
    expect(grounded(886568, 'money', cartola)).toBe(true);
  });

  it('una fecha ISO se reconoce en su forma local', () => {
    expect(grounded('2026-09-07', 'date', cartola)).toBe(true);
    expect(grounded('2026-07-29', 'date', poliza)).toBe(true);
  });

  it('UF 3,0 respalda un 3', () => {
    expect(grounded(3, 'uf', poliza)).toBe(true);
  });

  it('un número de póliza con separadores distintos igual calza', () => {
    // El documento dice "B-VP- 9344586-4"; el modelo limpia los espacios.
    expect(grounded('B-VP-9344586-4', 'text', poliza)).toBe(true);
  });

  it('DESCARTA lo que el documento no dice', () => {
    // Es el punto entero: separa "el modelo dijo" de "el documento dice".
    expect(grounded(5, 'uf', poliza)).toBe(false);
    expect(grounded('2026-01-01', 'date', cartola)).toBe(false);
    expect(grounded(999999, 'money', cartola)).toBe(false);
    expect(grounded('PATENTE-INVENTADA', 'text', poliza)).toBe(false);
  });
});
