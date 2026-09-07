/**
 * The action vocabulary, shared between the button and the keyboard.
 *
 * The verb is one string in both paths — **the "more" button carries `more`, and
 * someone without buttons types `more`** — so presentation has no two branches of
 * logic. What differs is what a verb *points at*, and that difference is not an
 * inconsistency: it is the whole reason both forms exist.
 *
 * A chat history stays on screen and stays tappable. Press the button of a list
 * from three days ago and a relative index resolves against the list shown
 * *now*: it does not fail, it opens a different document, which is the most
 * expensive way to be wrong. So the button carries the memory's id and is
 * correct forever. Nobody, on the other hand, is going to type eight hex
 * characters on a phone, so what is typed stays a position.
 *
 * The state that is left over — the cursor behind `more`, the text `save`
 * offers, the operation a `yes` repeats — still lives in the session table and
 * not in the payload. Putting ids in buttons drops the state of three actions
 * out of eight; the other five need it either way.
 */

/**
 * What a numbered action points at.
 *
 * An index is relative to the last list shown; an id points at itself and needs
 * no list at all. Same addressing the CLI already accepts when `dm show a3f2`
 * resolves a prefix.
 */
export type Target =
  | { by: 'index'; n: number }
  | { by: 'id'; id: string };

export type Action =
  | { kind: 'more' }
  | { kind: 'view'; target: Target }
  | { kind: 'open'; target: Target }
  /** The file of the memory you are looking at. No target: it is not from a list. */
  | { kind: 'original' }
  | { kind: 'save' }
  | { kind: 'hide'; target: Target }
  | { kind: 'yes' }
  | { kind: 'no' };

/** The actions that carry a target. */
const TARGETED = ['view', 'open', 'hide'] as const;

type Targeted = (typeof TARGETED)[number];

const isTargeted = (k: string): k is Targeted => (TARGETED as readonly string[]).includes(k);

/**
 * Whether the action stands on its own, with nothing on screen.
 *
 * An id is absolute, so `view:a3f2c1d0` typed into an empty conversation means
 * exactly one thing. An index does not, and a bare number with no list is
 * someone capturing a number.
 */
export const isAbsolute = (a: Action): boolean => 'target' in a && a.target.by === 'id';

/**
 * What travels in a button. Short, because chat platforms cap the payload:
 * `view:` plus an eight-character short id is 13 bytes against Telegram's 64.
 *
 * The kind *is* the wire string, and the encoder is almost a tautology on
 * purpose: one name per action, in English, matching the CLI. Two ways of saying
 * the same thing is one more thing to keep in sync forever.
 */
export const encodeAction = (a: Action): string =>
  'target' in a
    ? `${a.kind}:${a.target.by === 'index' ? a.target.n : a.target.id}`
    : a.kind;

/** Lower case and unaccented: nobody types accents on a phone. */
const normalize = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** The actions that stand alone, spelled exactly as their button. */
const BARE = ['more', 'save', 'original', 'yes', 'no'] as const;

/**
 * Reads a target with no ambiguity to resolve.
 *
 * One or two digits is a position; four or more hex characters is an id prefix.
 * The ranges cannot overlap, so there is no guessing and no precedence rule to
 * remember: `12` is the twelfth, `12ab` is an id, and a three-digit number is
 * neither — a list never has a hundred items and an id prefix that short would
 * match half the corpus.
 */
function parseTarget(raw: string): Target | null {
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= 99 ? { by: 'index', n } : null;
  }
  const hex = raw.replace(/-/g, '');
  return /^[0-9a-f]{4,32}$/.test(hex) ? { by: 'id', id: hex } : null;
}

/**
 * Reads an action, whether it came from a button or from the keyboard.
 *
 * `hasPending` matters: with no list on screen, a bare `3` is not "view the
 * third one", it is someone capturing the number 3. Confusing them would lose
 * the datum, and losing is the expensive mistake.
 */
export function parseAction(raw: string | null, hasPending: boolean): Action | null {
  if (!raw) return null;
  const s = normalize(raw);
  if (!s) return null;

  const targeted = /^([a-z]+)[:\s]([0-9a-f-]{1,36})$/.exec(s);
  if (targeted) {
    const kind = targeted[1]!;
    const target = parseTarget(targeted[2]!);
    if (isTargeted(kind) && target) return { kind, target };
  }

  if ((BARE as readonly string[]).includes(s)) return { kind: s } as Action;

  // A bare number only means something when a list is waiting.
  if (hasPending && /^\d{1,2}$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n <= 99) return { kind: 'view', target: { by: 'index', n } };
  }

  return null;
}
