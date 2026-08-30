/**
 * El core nunca pregunta ni formatea: devuelve datos.
 * `requires_confirmation` es lo que reemplaza a un diálogo — el llamador
 * decide cómo pedirla (--yes en el CLI, un botón en el chat, un 409 en HTTP).
 */
export type Affected = { kind: string; id: string; label?: string };

export type ErrKind = 'not_found' | 'forbidden' | 'invalid' | 'ambiguous' | 'conflict';

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; kind: ErrKind; message: string; detail?: unknown };
export type NeedsConfirmation = {
  ok: false;
  kind: 'requires_confirmation';
  message: string;
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
