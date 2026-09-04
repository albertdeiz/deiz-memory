import { normalizeNumber } from '../recall/grounding';
import type { FactField, FactValue, FieldKind } from './types';

/**
 * Validating an extracted value, and checking it is really in the document.
 *
 * Two different things, and both are needed. The first is shape: a date that is
 * not a date, a number that is not a number. The second is the one that matters:
 * **that the model did not invent it.** Same principle the answer path applies
 * to prose, moved to extraction time — cheaper, and done once.
 *
 * Pure logic: tested with no database, no network and no model.
 */

const withoutAccents = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Digits only. A phone number is written six different ways. */
const digits = (s: string): string => s.replace(/\D/g, '');

/**
 * A date, however it arrives.
 *
 * Local documents write `07/09/2026` and the model returns `2026-09-07`. Without
 * normalizing both to the same thing, the check that the datum is in the text
 * would discard precisely the correct values.
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

/** An actually valid date: 2026-02-31 passes the regex and does not exist. */
const realDate = (iso: string): boolean => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
};

/**
 * Leaves the value in canonical form, or null when it is not of this kind.
 *
 * Numbers come back as numbers and dates as ISO, so what lands in the payload is
 * already ready to compare and to sort.
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

/** Cap on how far back to look, for absurdly long rows. */
const WINDOW = 200;

/**
 * Every place in the document where this value appears, with its label.
 *
 * **The context is cut at the line break**, and that is not an implementation
 * detail: the document converter leaves each table row on its own line, so a
 * value's label is whatever sits to its left *in that row*. With a window that
 * crossed lines, the correct total was contaminated by the "previous period" of
 * the row above and the good value got disqualified.
 */
function occurrences(value: FactValue, kind: FieldKind, text: string): string[] {
  const windows: string[] = [];
  const push = (i: number, len: number) => {
    const lineStart = text.lastIndexOf('\n', i);
    const from = Math.max(lineStart + 1, i - WINDOW, 0);
    const end = text.indexOf('\n', i + len);
    windows.push(text.slice(from, end === -1 ? i + len + 40 : end));
  };

  switch (kind) {
    case 'date': {
      const [y, m, d] = String(value).split('-');
      const dd = String(Number(d));
      const mm = String(Number(m));
      for (const f of [`${y}-${m}-${d}`, `${d}/${m}/${y}`, `${dd}/${mm}/${y}`,
                       `${d}-${m}-${y}`, `${dd}-${mm}-${y}`, `${d}.${m}.${y}`]) {
        let i = text.indexOf(f);
        while (i >= 0) { push(i, f.length); i = text.indexOf(f, i + 1); }
      }
      return windows;
    }
    case 'phone': {
      // Documents split it with spaces and dashes, so there is no reliable
      // index: the whole document is accepted as context.
      return digits(text).includes(digits(String(value))) ? [text] : [];
    }
    case 'number':
    case 'uf':
    case 'money': {
      const target = normalizeNumber(String(value));
      for (const m of text.matchAll(/\d[\d.,]*\d|\d/g)) {
        if (normalizeNumber(m[0]) === target) push(m.index, m[0].length);
      }
      return windows;
    }
    case 'text': {
      const v = withoutAccents(String(value)).replace(/\s+/g, ' ').trim();
      if (v.length < 2) return [];
      let i = text.indexOf(v);
      while (i >= 0) { push(i, v.length); i = text.indexOf(v, i + 1); }
      if (windows.length === 0) {
        const bare = (t: string) => t.replace(/[\s.\-/]/g, '');
        if (bare(text).includes(bare(v))) return [text];
      }
      return windows;
    }
  }
}

/**
 * Is this value in the document, and **under the right label**?
 *
 * Not compared character by character: an amount the PDF writes as `$886.568`
 * and the model returns as `886568` is the same datum, and `07/09/2026` is the
 * same date as `2026-09-07`. The normalized value is compared against every
 * form the document might have written it in.
 *
 * **And then the surroundings are checked**, which is the part that took work
 * to find. A card statement carries `MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR)
 * $886.568` and `MONTO TOTAL FACTURADO A PAGAR $1.747.885`: both figures exist,
 * both passed the check, and the answer was last month's. The decoy's label
 * containing the good one is what makes `notNear` the indispensable half — what
 * separates them is not what they share but what is extra.
 *
 * A field with neither `near` nor `notNear` behaves as before: the value merely
 * has to be present. Most fields need nothing more.
 */
export function grounded(value: FactValue, field: FactField, source: string): boolean {
  const text = withoutAccents(source);
  const windows = occurrences(value, field.kind, text);
  if (windows.length === 0) return false;

  const near = (field.near ?? []).map(withoutAccents);
  const notNear = (field.notNear ?? []).map(withoutAccents);
  if (near.length === 0 && notNear.length === 0) return true;

  // ONE well-labelled occurrence is enough: the same number can appear ten times
  // and only one of them be the one that answers.
  return windows.some((v) =>
    (near.length === 0 || near.some((n) => v.includes(n))) &&
    !notNear.some((n) => v.includes(n)),
  );
}
