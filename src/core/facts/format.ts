import type { FactHit } from './query.js';
import type { FieldKind } from './types.js';

/**
 * Cómo se escribe un valor tipado.
 *
 * Está en el core y no en un adapter porque no es prosa: es la forma canónica
 * de un dato —`UF 3,0`, `$886.568`— y tiene que ser la misma en la terminal y
 * en el chat. La prosa que lo rodea sí es de cada adapter.
 */
export function renderValue(value: string | number, kind: FieldKind): string {
  switch (kind) {
    case 'money':
      return `$${Number(value).toLocaleString('es-CL')}`;
    case 'uf':
      return `UF ${String(value).replace('.', ',')}`;
    case 'number':
      return String(value).replace('.', ',');
    case 'phone': {
      const d = String(value);
      return d.length === 11 && d.startsWith('56') ? `+56 ${d.slice(2, 3)} ${d.slice(3, 7)} ${d.slice(7)}` : d;
    }
    default:
      return String(value);
  }
}

const day = (d: Date | null): string | null => d?.toISOString().slice(0, 10) ?? null;

/**
 * La advertencia que va **antes** del dato (regla dura 10).
 *
 * Devuelve null cuando no hay nada que advertir. Que sea un dato y no una
 * cadena armada en el renderer es lo que permite comprobar en un test que la
 * advertencia precede al valor, en los dos canales.
 */
export function warningFor(hit: FactHit): string | null {
  if (hit.superseded) return 'Está superado por uno más nuevo';
  if (hit.expired) {
    const hasta = day(hit.fact.validUntil);
    return hasta ? `Está vencido desde el ${hasta}` : 'Está vencido';
  }
  return null;
}

/**
 * De dónde salió el dato: qué tipo, cuál instancia y de qué ventana.
 *
 * La identidad va acá y no como un campo más: con dos tarjetas o dos autos,
 * saber cuál es el dato importa tanto como el dato. Y ponerla en la línea de
 * contexto evita tener que preguntarla, que era lo que pasaba cuando su alias
 * la arrastraba a toda respuesta.
 */
export function contextOf(hit: FactHit): string {
  const desde = day(hit.fact.validFrom);
  const hasta = day(hit.fact.validUntil);
  const cual = hit.fact.identity ? ` ${hit.fact.identity}` : '';
  const ventana = !desde && !hasta
    ? ''
    : hit.fact.kind === 'periodo'
      ? ` · período ${desde ?? '—'} a ${hasta ?? '—'}`
      : ` · vigente ${desde ?? '—'} a ${hasta ?? '—'}`;
  return `${hit.fact.typeLabel}${cual}${ventana}`;
}
