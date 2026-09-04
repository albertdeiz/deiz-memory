/**
 * Every figure in an answer has to actually be in what was read.
 *
 * The citation check confirms the cited memory id exists among the sources. It
 * does not confirm that **the number** came from there, and that gap lets
 * through the worst possible case: an answer with a valid citation and an
 * invented figure, which reads as *more* trustworthy than one with no citation.
 *
 * Measured on a real policy: asked for the deductible on a car insurance
 * policy, the model answered "5 UF [a853a71c]". None of the eight retrieved
 * passages contained that figure — the only ones in UF were `UF3`, part of a
 * product name, and `UF 10`. The citation was valid; the number was not.
 *
 * Pure logic, like the lane router and the chunker: a product rule, tested with
 * no database, no network and no model.
 */

/** Units whose confusion changes what a figure means. */
const UNITS = ['uf', 'utm', 'clp', 'usd', '%', '$'] as const;

/**
 * A number written any way at all, reduced to its value.
 *
 * In Chile the decimal separator is the comma and the thousands separator the
 * dot, so `UF 3,0` and `3 UF` are the same number and `$89.990` is eighty-nine
 * thousand nine hundred ninety. Without normalizing, the *correct* answer would
 * be discarded for not matching the source character by character.
 */
export function normalizeNumber(raw: string): string {
  let s = raw.replace(/\s/g, '');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');

  if (comma >= 0 && dot >= 0) {
    // The last separator wins: the other one is for thousands.
    s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (comma >= 0) {
    s = s.replace(',', '.');
  } else if (dot >= 0) {
    // `89.990` is thousands; `3.5` is decimal. Three trailing digits tell them apart.
    const tail = s.slice(dot + 1);
    s = tail.length === 3 ? s.replace(/\./g, '') : s;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return raw;
  // No trailing zeros: `3,0` and `3` are the same datum.
  return String(Number(n.toFixed(4)));
}

const UNIT_RE = UNITS.map((u) => (u === '$' ? '\\$' : u)).join('|');
const SCAN = new RegExp(
  `(${UNIT_RE})?\\s{0,2}(\\d[\\d.,]*\\d|\\d)\\s{0,2}(${UNIT_RE}|pesos)?`,
  'gi',
);

export interface Figures {
  /** Every value, unitless. */
  values: Set<string>;
  /** The ones that came attached to a unit, as `3|uf`. */
  pairs: Set<string>;
}

/**
 * The figures in a text, with whatever unit accompanies them.
 *
 * The unit is looked for on both sides because documents write `UF 3,0` and
 * people write `3 UF`. Same fact.
 */
export function figures(text: string): Figures {
  const values = new Set<string>();
  const pairs = new Set<string>();
  for (const m of text.toLowerCase().matchAll(SCAN)) {
    const value = normalizeNumber(m[2]!);
    values.add(value);
    const before = m[1];
    const after = m[3] === 'pesos' ? '$' : m[3];
    if (before) pairs.add(`${value}|${before}`);
    if (after) pairs.add(`${value}|${after}`);
  }
  return { values, pairs };
}

export interface Grounding {
  ok: boolean;
  /** What the answer asserts and the source does not say. For the log, not the user. */
  ungrounded: string[];
}

/** Citations carry digits that are not data: `[a853a71c]`, `[1]`. */
const stripCitations = (s: string): string => s.replace(/\[[0-9a-f]{1,8}\]/gi, ' ');

/**
 * Does every figure in the prose appear in the passages that were read?
 *
 * Strict on purpose. A spurious "I do not have it" is recoverable — the
 * passages are shown anyway and the person opens them. An invented number with
 * a valid citation is recoverable by nothing, because nothing gives it away. A
 * high rate of honest "I do not have it" is healthy; a single confident lie is
 * not.
 *
 * Two things are checked, and the second catches the subtler failure: `$89.990`
 * rendered as `89.990 UF` has the right number and an invented unit.
 */
export function checkGrounding(prose: string, passages: string[]): Grounding {
  const claimed = figures(stripCitations(prose));
  const source = figures(passages.join('\n'));

  const ungrounded = [
    ...[...claimed.values].filter((v) => !source.values.has(v)),
    ...[...claimed.pairs]
      .filter((p) => !source.pairs.has(p))
      .map((p) => {
        const [value, unit] = p.split('|');
        return `${value} ${unit}`;
      }),
  ];

  return { ok: ungrounded.length === 0, ungrounded };
}
