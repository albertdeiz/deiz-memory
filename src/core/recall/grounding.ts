/**
 * Que cada cifra de la respuesta esté de verdad en lo que se leyó.
 *
 * La verificación de cita (regla dura 1) comprueba que el `memory_id` citado
 * exista entre las fuentes. No comprueba que **el número** venga de ahí, y ese
 * hueco deja pasar el peor caso posible: una respuesta con cita válida y cifra
 * inventada, que resulta *más* creíble que una sin cita.
 *
 * Medido sobre una póliza real: a "¿cuál es el deducible de mi seguro de auto?"
 * el modelo contestó "5 UF [a853a71c]". Ninguno de los ocho pasajes recuperados
 * contenía esa cifra —las únicas en UF eran `UF3`, parte del nombre del
 * convenio, y `UF 10`—. La cita era válida; el número, no.
 *
 * Lógica pura, como `lanes.ts` y `chunk.ts`: es una regla del producto y se
 * prueba sin base, sin red y sin modelo.
 */

/** Unidades que cambian el significado de una cifra si se equivocan. */
const UNITS = ['uf', 'utm', 'clp', 'usd', '%', '$'] as const;

/**
 * Un número escrito como sea, reducido a su valor.
 *
 * En Chile el separador decimal es la coma y el de miles el punto, así que
 * `UF 3,0` y `3 UF` son el mismo número, y `$89.990` son ochenta y nueve mil
 * novecientos noventa. Sin normalizar, la respuesta *correcta* se descartaría
 * por no coincidir carácter a carácter con la fuente.
 */
export function normalizeNumber(raw: string): string {
  let s = raw.replace(/\s/g, '');
  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');

  if (coma >= 0 && punto >= 0) {
    // El último separador manda: el otro es de miles.
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma >= 0) {
    s = s.replace(',', '.');
  } else if (punto >= 0) {
    // `89.990` son miles; `3.5` es decimal. Tres dígitos detrás lo delatan.
    const cola = s.slice(punto + 1);
    s = cola.length === 3 ? s.replace(/\./g, '') : s;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return raw;
  // Sin ceros de cola: `3,0` y `3` son el mismo dato.
  return String(Number(n.toFixed(4)));
}

const UNIT_RE = UNITS.map((u) => (u === '$' ? '\\$' : u)).join('|');
const SCAN = new RegExp(
  `(${UNIT_RE})?\\s{0,2}(\\d[\\d.,]*\\d|\\d)\\s{0,2}(${UNIT_RE}|pesos)?`,
  'gi',
);

export interface Figures {
  /** Todos los valores, sin unidad. */
  values: Set<string>;
  /** Los que venían pegados a una unidad, como `3|uf`. */
  pairs: Set<string>;
}

/**
 * Las cifras de un texto, con la unidad que las acompaña cuando la hay.
 *
 * La unidad se mira a los dos lados porque los documentos escriben `UF 3,0` y
 * las personas escriben `3 UF`. Son el mismo hecho.
 */
export function figures(text: string): Figures {
  const values = new Set<string>();
  const pairs = new Set<string>();
  for (const m of text.toLowerCase().matchAll(SCAN)) {
    const valor = normalizeNumber(m[2]!);
    values.add(valor);
    const antes = m[1];
    const despues = m[3] === 'pesos' ? '$' : m[3];
    if (antes) pairs.add(`${valor}|${antes}`);
    if (despues) pairs.add(`${valor}|${despues}`);
  }
  return { values, pairs };
}

export interface Grounding {
  ok: boolean;
  /** Lo que la respuesta afirma y la fuente no dice. Para el log, no para el usuario. */
  ungrounded: string[];
}

/** Las citas traen dígitos que no son datos: `[a853a71c]`, `[1]`. */
const stripCitations = (s: string): string => s.replace(/\[[0-9a-f]{1,8}\]/gi, ' ');

/**
 * ¿Toda cifra de la prosa aparece en los pasajes que se leyeron?
 *
 * Estricto a propósito. Un "no lo tengo" de más se recupera —los pasajes se
 * muestran igual, y la persona los abre—; un número inventado con cita válida
 * no se recupera de ninguna forma, porque nada lo delata. §15 lo dice al revés
 * y es lo mismo: la tasa de "no lo tengo" es sana **si es honesta**.
 *
 * Se verifican dos cosas, y la segunda es la que atrapa el fallo conocido de
 * F3: `$89.990` redactado como `89.990 UF` tiene el número correcto y la unidad
 * inventada.
 */
export function checkGrounding(prose: string, passages: string[]): Grounding {
  const dicho = figures(stripCitations(prose));
  const fuente = figures(passages.join('\n'));

  const ungrounded = [
    ...[...dicho.values].filter((v) => !fuente.values.has(v)),
    ...[...dicho.pairs]
      .filter((p) => !fuente.pairs.has(p))
      .map((p) => {
        const [v, u] = p.split('|');
        return `${v} ${u}`;
      }),
  ];

  return { ok: ungrounded.length === 0, ungrounded };
}
