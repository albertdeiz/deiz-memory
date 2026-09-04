import { normalizeNumber } from '../recall/grounding.js';
import type { FactValue, FieldKind } from './types.js';

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
export function grounded(value: FactValue, kind: FieldKind, source: string): boolean {
  const texto = sinTildes(source);

  switch (kind) {
    case 'date': {
      const [y, m, d] = String(value).split('-');
      const dd = String(Number(d));
      const mm = String(Number(m));
      // ISO, y las dos formas locales con y sin cero a la izquierda.
      const formas = [
        `${y}-${m}-${d}`,
        `${d}/${m}/${y}`, `${dd}/${mm}/${y}`,
        `${d}-${m}-${y}`, `${dd}-${mm}-${y}`,
        `${d}.${m}.${y}`,
      ];
      return formas.some((f) => texto.includes(f));
    }
    case 'phone': {
      const d = digits(String(value));
      // El documento lo puede partir con espacios o guiones en cualquier lado.
      return digits(texto).includes(d);
    }
    case 'number':
    case 'uf':
    case 'money': {
      const objetivo = normalizeNumber(String(value));
      // Cada número del documento, normalizado igual. Comparar así hace que
      // `UF 3,0` case con `3` y `$886.568` con `886568`.
      for (const m of texto.matchAll(/\d[\d.,]*\d|\d/g)) {
        if (normalizeNumber(m[0]) === objetivo) return true;
      }
      return false;
    }
    case 'text': {
      const v = sinTildes(String(value)).replace(/\s+/g, ' ').trim();
      if (v.length < 2) return false;
      // Los números de póliza y tarjeta vienen con separadores que el modelo
      // limpia: `B-VP- 9344586-4` → `B-VP-9344586-4`. Se compara sin ruido.
      const limpio = (t: string) => t.replace(/[\s.\-/]/g, '');
      return texto.includes(v) || limpio(texto).includes(limpio(v));
    }
  }
}
