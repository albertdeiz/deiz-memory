import { normalizeNumber } from '../recall/grounding.js';
import type { FactField, FactValue, FieldKind } from './types.js';

/**
 * Validar un valor extraído, y comprobar que de verdad esté en el documento.
 *
 * Son dos cosas distintas y las dos hacen falta. La primera es de forma: una
 * fecha que no es fecha, un número que no es número. La segunda es la que
 * importa: **que el modelo no lo haya inventado.** Es el mismo principio que
 * `grounding.ts` aplica a la prosa de una respuesta (§6), movido al momento de
 * extraer — que es más barato y se hace una sola vez.
 *
 * Lógica pura: se prueba sin base, sin red y sin modelo.
 */

const sinTildes = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Solo los dígitos. Un teléfono se escribe de seis formas distintas. */
const digits = (s: string): string => s.replace(/\D/g, '');

/**
 * Una fecha, venga como venga.
 *
 * Los documentos chilenos escriben `07/09/2026` y el modelo devuelve
 * `2026-09-07`. Sin normalizar las dos a lo mismo, el chequeo de que el dato
 * está en el texto descartaría justo los valores correctos.
 */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (local) {
    const [, d, m, y] = local;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  return null;
}

/** Una fecha válida de verdad: 2026-02-31 pasa la regex y no existe. */
const realDate = (iso: string): boolean => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
};

/**
 * Deja el valor en su forma canónica, o null si no es de este tipo.
 *
 * Los números vuelven como número y las fechas como ISO, así que lo que se
 * guarda en el `payload` ya está listo para comparar y para ordenar.
 */
export function coerce(raw: unknown, kind: FieldKind): FactValue | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  switch (kind) {
    case 'date': {
      const iso = normalizeDate(s);
      return iso && realDate(iso) ? iso : null;
    }
    case 'number':
    case 'uf':
    case 'money': {
      const m = /-?\d[\d.,]*/.exec(s);
      if (!m) return null;
      const n = Number(normalizeNumber(m[0]));
      return Number.isFinite(n) ? n : null;
    }
    case 'phone': {
      const d = digits(s);
      return d.length >= 6 ? d : null;
    }
    case 'text':
      return s.slice(0, 200);
  }
}

/**
 * ¿Este valor está en el documento?
 *
 * No se compara carácter a carácter: un monto que el PDF escribe `$886.568` y
 * el modelo devuelve `886568` es el mismo dato, y una fecha `07/09/2026` es la
 * misma que `2026-09-07`. Se compara **el valor normalizado contra todas las
 * formas en que el documento pudo escribirlo**.
 *
 * Un campo que no pasa por acá no se guarda. Es lo que separa "el modelo dijo"
 * de "el documento dice".
 */
/** Tope de contexto hacia atrás, cuando la fila es larguísima. */
const VENTANA = 200;

/**
 * Cada trozo del documento donde aparece este valor, con su rótulo.
 *
 * **El contexto se corta en el salto de línea**, y eso no es un detalle de
 * implementación: markitdown deja cada fila de una tabla en su propia línea, así
 * que el rótulo de un valor es lo que está a su izquierda *en esa fila*. Con una
 * ventana que cruzaba líneas, el `MONTO TOTAL FACTURADO A PAGAR` se contaminaba
 * con el `PERÍODO ANTERIOR` de la fila de arriba y quedaba descalificado el
 * valor bueno.
 */
function occurrences(value: FactValue, kind: FieldKind, texto: string): string[] {
  const ventanas: string[] = [];
  const push = (i: number, len: number) => {
    const salto = texto.lastIndexOf('\n', i);
    const desde = Math.max(salto + 1, i - VENTANA, 0);
    const fin = texto.indexOf('\n', i + len);
    ventanas.push(texto.slice(desde, fin === -1 ? i + len + 40 : fin));
  };

  switch (kind) {
    case 'date': {
      const [y, m, d] = String(value).split('-');
      const dd = String(Number(d));
      const mm = String(Number(m));
      for (const f of [`${y}-${m}-${d}`, `${d}/${m}/${y}`, `${dd}/${mm}/${y}`,
                       `${d}-${m}-${y}`, `${dd}-${mm}-${y}`, `${d}.${m}.${y}`]) {
        let i = texto.indexOf(f);
        while (i >= 0) { push(i, f.length); i = texto.indexOf(f, i + 1); }
      }
      return ventanas;
    }
    case 'phone': {
      // El documento lo parte con espacios y guiones, así que no hay índice
      // fiable: se acepta el documento entero como contexto.
      return digits(texto).includes(digits(String(value))) ? [texto] : [];
    }
    case 'number':
    case 'uf':
    case 'money': {
      const objetivo = normalizeNumber(String(value));
      for (const m of texto.matchAll(/\d[\d.,]*\d|\d/g)) {
        if (normalizeNumber(m[0]) === objetivo) push(m.index, m[0].length);
      }
      return ventanas;
    }
    case 'text': {
      const v = sinTildes(String(value)).replace(/\s+/g, ' ').trim();
      if (v.length < 2) return [];
      let i = texto.indexOf(v);
      while (i >= 0) { push(i, v.length); i = texto.indexOf(v, i + 1); }
      if (ventanas.length === 0) {
        const limpio = (t: string) => t.replace(/[\s.\-/]/g, '');
        if (limpio(texto).includes(limpio(v))) return [texto];
      }
      return ventanas;
    }
  }
}

/**
 * ¿Este valor está en el documento, y **bajo el rótulo correcto**?
 *
 * No se compara carácter a carácter: un monto que el PDF escribe `$886.568` y
 * el modelo devuelve `886568` es el mismo dato, y `07/09/2026` es la misma
 * fecha que `2026-09-07`. Se compara el valor normalizado contra todas las
 * formas en que el documento pudo escribirlo.
 *
 * **Y después se mira alrededor**, que es la parte que costó descubrir. Una
 * cartola trae `MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR) $886.568` y
 * `MONTO TOTAL FACTURADO A PAGAR $1.747.885`: las dos cifras existen, las dos
 * pasaban el chequeo, y la respuesta era la del mes pasado. Que el rótulo del
 * señuelo contenga al del bueno es lo que hace que `notNear` sea la mitad
 * indispensable — lo que los separa no es lo que tienen, es lo que sobra.
 *
 * Un campo sin `near` ni `notNear` se comporta como antes: basta que el valor
 * esté. La mayoría no necesita más.
 */
export function grounded(value: FactValue, field: FactField, source: string): boolean {
  const texto = sinTildes(source);
  const ventanas = occurrences(value, field.kind, texto);
  if (ventanas.length === 0) return false;

  const near = (field.near ?? []).map(sinTildes);
  const notNear = (field.notNear ?? []).map(sinTildes);
  if (near.length === 0 && notNear.length === 0) return true;

  // Basta con que UNA ocurrencia esté bien rotulada: el mismo número puede
  // aparecer diez veces y solo una ser la que responde.
  return ventanas.some((v) =>
    (near.length === 0 || near.some((n) => v.includes(n))) &&
    !notNear.some((n) => v.includes(n)),
  );
}
