/**
 * The action vocabulary, shared between the button and the keyboard.
 *
 * This is the piece that makes graceful degradation real, and it is simpler
 * than it looks: **the "more" button carries the string `more`, and someone
 * without buttons types `more`.** Both produce the same action, so presentation
 * has no two branches of logic — it has two ways of showing the same list.
 *
 * And it only works because the state lives in the session table and not inside
 * the button payload. If the cursor travelled in the callback data, a channel
 * without buttons could not reproduce it: nobody is going to type a 64-byte
 * token.
 */
export type Action =
  | { kind: 'more' }
  | { kind: 'view'; n: number }
  | { kind: 'open'; n: number }
  /** The file of the memory you are looking at. No number: it is not from a list. */
  | { kind: 'original' }
  | { kind: 'save' }
  | { kind: 'hide'; n: number }
  | { kind: 'yes' }
  | { kind: 'no' };

/** The actions that carry a position in the last list shown. */
const NUMBERED = ['view', 'open', 'hide'] as const;

type Numbered = (typeof NUMBERED)[number];

const isNumbered = (k: string): k is Numbered => (NUMBERED as readonly string[]).includes(k);

/**
 * What travels in a button. Short, because chat platforms cap the payload.
 *
 * The kind *is* the wire string, and the encoder is almost a tautology on
 * purpose: one name per action, in English, matching the CLI. Two ways of saying
 * the same thing is one more thing to keep in sync forever.
 */
export const encodeAction = (a: Action): string =>
  'n' in a ? `${a.kind}:${a.n}` : a.kind;

/** Lower case and unaccented: nobody types accents on a phone. */
const normalize = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** The actions that stand alone, spelled exactly as their button. */
const BARE = ['more', 'save', 'original', 'yes', 'no'] as const;

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

  const numbered = /^([a-z]+)[:\s](\d{1,2})$/.exec(s);
  if (numbered) {
    const kind = numbered[1]!;
    const n = Number(numbered[2]);
    if (isNumbered(kind) && n >= 1 && n <= 99) return { kind, n };
  }

  if ((BARE as readonly string[]).includes(s)) return { kind: s } as Action;

  // A bare number only means something when a list is waiting.
  if (hasPending && /^\d{1,2}$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n <= 99) return { kind: 'view', n };
  }

  return null;
}
