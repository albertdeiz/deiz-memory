import type { FactHit } from './query';
import type { FieldKind } from './types';

/**
 * How a typed value is written.
 *
 * This lives in the core and not in an adapter because it is not prose: it is
 * the canonical shape of a datum, and it has to be the same in the terminal and
 * in chat. The prose around it does belong to each adapter.
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
 * The warning that goes **before** the datum.
 *
 * Returns null when there is nothing to warn about. Keeping it as data rather
 * than a string assembled in the renderer is what lets a test assert the
 * warning precedes the value, in both channels.
 */
export function warningFor(hit: FactHit): string | null {
  if (hit.superseded) return 'Está superado por uno más nuevo';
  if (hit.expired) {
    const until = day(hit.fact.validUntil);
    return until ? `Está vencido desde el ${until}` : 'Está vencido';
  }
  return null;
}

/**
 * Where the datum came from: which type, which instance, which window.
 *
 * The identity goes here and not as another field: with two cards or two cars,
 * knowing which one the datum belongs to matters as much as the datum. Putting
 * it on the context line avoids having to ask for it, which is what happened
 * while its alias dragged it into every answer.
 */
export function contextOf(hit: FactHit): string {
  const from = day(hit.fact.validFrom);
  const until = day(hit.fact.validUntil);
  // The document's title before the type's label: with two cards, the title
  // tells them apart and a masked number does not.
  const what = hit.fact.memoryTitle ?? hit.fact.typeLabel;
  const which = hit.fact.identity ? ` ${hit.fact.identity}` : '';
  const window = !from && !until
    ? ''
    : hit.fact.kind === 'period'
      ? ` · período ${from ?? '—'} a ${until ?? '—'}`
      : ` · vigente ${from ?? '—'} a ${until ?? '—'}`;
  return `${what}${which}${window}`;
}

/**
 * Is this an actual conflict?
 *
 * Two different cards with two different amounts are **not** a conflict: they
 * are two cards. A conflict is the same field, of the same type, of the same
 * instance, live twice — two policies for the same car with different
 * deductibles. Warning about the first teaches people to ignore the warning, and
 * then it stops working for the second.
 */
export function conflicting(hits: FactHit[]): boolean {
  const live = hits.filter((h) => !h.expired && !h.superseded);
  const keys = new Set<string>();
  for (const h of live) {
    const k = `${h.fact.typeId}|${h.fact.identity ?? ''}|${h.ref.field.name}`;
    if (keys.has(k)) return true;
    keys.add(k);
  }
  return false;
}
