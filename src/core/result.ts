/**
 * The core never asks and never formats: it returns data.
 *
 * `requires_confirmation` is what replaces a dialog — the caller decides how to
 * ask for it (`--yes` on the CLI, a button in chat, a 409 over HTTP). That is
 * what lets a second channel exist without touching any of this.
 */
export type Affected = { kind: string; id: string; label?: string };

export type ErrKind = 'not_found' | 'forbidden' | 'invalid' | 'ambiguous' | 'conflict';

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; kind: ErrKind; message: string; detail?: unknown };
export type NeedsConfirmation = {
  ok: false;
  kind: 'requires_confirmation';
  message: string;
  /** Named, not counted: a confirmation that says "3 items" tells you nothing. */
  affects: Affected[];
};

export type Result<T> = Ok<T> | Err | NeedsConfirmation;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = (kind: ErrKind, message: string, detail?: unknown): Err =>
  detail === undefined ? { ok: false, kind, message } : { ok: false, kind, message, detail };

export const needsConfirmation = (message: string, affects: Affected[]): NeedsConfirmation => ({
  ok: false,
  kind: 'requires_confirmation',
  message,
  affects,
});

export const isOk = <T>(r: Result<T>): r is Ok<T> => r.ok;

/**
 * A failure that retrying will not fix.
 *
 * The distinction is not cosmetic: retrying helps when the cause was transient
 * — a service down, an API throttling, a timeout — and does nothing at all when
 * the lane simply cannot read that format. Offering the same button for both is
 * offering a button that sometimes does nothing, which teaches people to
 * distrust the button.
 *
 * Declared by whatever failed, the only place that knows. Everything else is
 * assumed transient: erring toward "retry" costs one run, while erring toward
 * "do not bother" hides a memory forever.
 */
export class PermanentError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export const isPermanent = (e: unknown): boolean =>
  e instanceof PermanentError || (e as { permanent?: boolean })?.permanent === true;
