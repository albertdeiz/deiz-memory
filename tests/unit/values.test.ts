import { describe, expect, it } from 'vitest';
import { coerce, grounded, normalizeDate, withoutLabel } from '../../src/core/facts/values';
import { relevantContext } from '../../src/core/facts/prompt';

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

/** A minimal field: only the kind matters unless the labels are being tested. */
const campo = (kind: 'text'|'number'|'uf'|'money'|'date'|'phone', over = {}) =>
  ({ name: 'x', kind, label: 'x', aliases: [], ...over });

describe('grounded · que el documento lo diga', () => {
  const poliza = 'Poliza N° B-VP- 9344586-4 · Patente VHWD58 · Deducible UF 3,0 · vigencia 29-07-2026';
  const cartola = 'MONTO FACTURADO A PAGAR $886.568 — PAGAR HASTA 07/09/2026 — CUPO TOTAL $12.500.000';

  it('un monto escrito con puntos es el mismo número', () => {
    expect(grounded(886568, campo('money'), cartola)).toBe(true);
  });

  it('una fecha ISO se reconoce en su forma local', () => {
    expect(grounded('2026-09-07', campo('date'), cartola)).toBe(true);
    expect(grounded('2026-07-29', campo('date'), poliza)).toBe(true);
  });

  it('UF 3,0 respalda un 3', () => {
    expect(grounded(3, campo('uf'), poliza)).toBe(true);
  });

  it('un número de póliza con separadores distintos igual calza', () => {
    // The document has separators the model strips out.
    expect(grounded('B-VP-9344586-4', campo('text'), poliza)).toBe(true);
  });

  it('DESCARTA lo que el documento no dice', () => {
    // Es el punto entero: separa "el modelo dijo" de "el documento dice".
    expect(grounded(5, campo('uf'), poliza)).toBe(false);
    expect(grounded('2026-01-01', campo('date'), cartola)).toBe(false);
    expect(grounded(999999, campo('money'), cartola)).toBe(false);
    expect(grounded('PATENTE-INVENTADA', campo('text'), poliza)).toBe(false);
  });
});

/**
 * The label, not just the figure.
 *
 * A real statement carries both rows: one for the previous period and one for
 * the current total. Both figures are in the document and both passed the check
 * — and the answer was last month's, with complete confidence.
 * 
 */
describe('grounded · bajo qué rótulo', () => {
  const cartola = [
    'MONTO FACTURADO A PAGAR (PERIODO ANTERIOR)  $886.568',
    'MONTO PAGADO PERIODO ANTERIOR  $-929.414',
    'MONTO TOTAL FACTURADO A PAGAR  $ 1.747.885',
    'MONTO MINIMO A PAGAR  $ 1.747.885',
  ].join('\n');

  const monto = campo('money', {
    near: ['total facturado a pagar'],
    notNear: ['anterior', 'minimo', 'pagado'],
  });

  it('rechaza la cifra del período anterior, aunque esté en el documento', () => {
    expect(grounded(886568, monto, cartola)).toBe(false);
  });

  it('acepta la del período actual', () => {
    expect(grounded(1747885, monto, cartola)).toBe(true);
  });

  it('basta con que UNA ocurrencia esté bien rotulada', () => {
    // The figure appears twice: under the total and under the minimum payment.
    // La segunda no descalifica a la primera.
    expect(grounded(1747885, monto, cartola)).toBe(true);
  });

  it('un campo sin rótulos se comporta como antes', () => {
    expect(grounded(886568, campo('money'), cartola)).toBe(true);
  });
});

/**
 * Which part of the document the extractor sees.
 *
 * In a real statement the correct total sat at character 6157 and the cut was at
 * 6000: the model never saw the right figure and returned the previous period's,
 * which did fit. A hundred and fifty-seven characters separated a good answer
 * from a well-formatted lie.
 */
describe('el contexto del extractor', () => {
  const tipo = {
    id: 't', slug: 'x', label: 'X', description: '', kind: 'period' as const,
    domainSlug: null, identityField: null, validFromField: null, validUntilField: null,
    active: true,
    fields: [campo('money', { near: ['total facturado a pagar'] })],
  };

  it('rescata la línea del rótulo aunque esté pasado el corte', () => {
    const relleno = 'relleno de la cartola. '.repeat(500);
    const doc = `${relleno}\nMONTO TOTAL FACTURADO A PAGAR  $ 1.747.885\n${relleno}`;
    const ctx = relevantContext(tipo, doc);
    expect(ctx).toContain('1.747.885');
  });

  it('un documento corto se manda entero', () => {
    expect(relevantContext(tipo, 'dos lineas\ny ya')).toBe('dos lineas\ny ya');
  });
});

/**
 * Medido sobre una póliza real: el modelo devolvió `numero` como
 * "póliza N°BP9344586" — el número con su rótulo pegado. Pasaba todos los
 * chequeos, porque es literalmente lo que dice el documento y eso es justo lo
 * que grounding exige. Pero el dato es BP9344586, y la diferencia aparece el
 * día en que dos documentos escriben la misma póliza distinto.
 */
describe('un valor no se lleva su propio rótulo', () => {
  const numero = {
    name: 'numero', label: 'número de póliza', kind: 'text' as const,
    aliases: ['poliza', 'numero'],
  };

  it('el caso real: despega el rótulo y el N°', () => {
    expect(withoutLabel('póliza N°BP9344586', numero)).toBe('BP9344586');
  });

  it('da igual el acento, la caja y el marcador de número', () => {
    for (const v of ['Poliza No. BP9344586', 'PÓLIZA Nº BP9344586', 'poliza #BP9344586',
                     'Número de póliza: BP9344586']) {
      expect(withoutLabel(v, numero)).toBe('BP9344586');
    }
  });

  it('un valor que ya viene limpio no se toca', () => {
    expect(withoutLabel('BP-9344586', numero)).toBe('BP-9344586');
    expect(withoutLabel('VHWD58', { ...numero, name: 'patente', label: 'patente del vehículo', aliases: ['patente', 'placa'] })).toBe('VHWD58');
  });

  it('nunca convierte un valor en nada', () => {
    // Si despojar se come todo, es que no había rótulo: era el valor.
    expect(withoutLabel('póliza', numero)).toBe('póliza');
    expect(withoutLabel('numero', numero)).toBe('numero');
  });

  it('las palabras cortas del rótulo no se comen el valor', () => {
    // "de" y "la" están en el label y morderían cualquier valor que empiece así.
    const f = { name: 'x', label: 'numero de la cosa', kind: 'text' as const, aliases: [] };
    expect(withoutLabel('DE-4471', f)).toBe('DE-4471');
  });
});

/**
 * Medido sobre un certificado real: el Registro Civil imprime "9 Enero 2026", y
 * ninguna de las dos mitades del pipeline lo veía — el valor no parseaba, y aun
 * parseado no se encontraba en el documento, así que grounding lo descartaba.
 * La consecuencia no es cosmética: un `valid_until` escrito así nunca se
 * capturaba, así que la regla dura 10 no podía dispararse justo en los
 * documentos que caducan.
 */
describe('las fechas escritas en palabras', () => {
  it('el caso real del certificado', () => {
    expect(normalizeDate('9 Enero 2026')).toBe('2026-01-09');
    expect(normalizeDate('29 Noviembre 1994')).toBe('1994-11-29');
  });

  it('con "de", abreviadas, con guiones y sin acentos', () => {
    expect(normalizeDate('29 de noviembre de 1994')).toBe('1994-11-29');
    expect(normalizeDate('09-ENE-2026')).toBe('2026-01-09');
    expect(normalizeDate('1 setiembre 2026')).toBe('2026-09-01');
    expect(normalizeDate('3 de Diciembre de 2026')).toBe('2026-12-03');
  });

  it('un mes que no existe no es una fecha', () => {
    expect(normalizeDate('9 Enerillo 2026')).toBeNull();
    expect(normalizeDate('9 2026')).toBeNull();
  });

  it('y se encuentran en el documento, que es la otra mitad', () => {
    // Sin esto el valor parsea y grounding lo descarta igual, porque busca
    // 2026-01-09 en un texto que dice "9 Enero 2026".
    const campo = { name: 'emision', label: 'emisión', kind: 'date' as const, aliases: [] };
    expect(grounded('2026-01-09', campo, 'Fecha de emisión: 9 Enero 2026')).toBe(true);
    expect(grounded('1994-11-29', campo, 'Nacido el 29 de noviembre de 1994')).toBe(true);
    // Y una fecha que el documento no dice sigue sin respaldo.
    expect(grounded('2026-01-09', campo, 'Fecha de emisión: 9 Marzo 2026')).toBe(false);
  });
});
