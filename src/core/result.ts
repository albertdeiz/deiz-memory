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

/**
 * Un fallo que reintentar no va a arreglar.
 *
 * La distinción no es cosmética: `dm reprocess --failed` sirve cuando la causa
 * fue transitoria —un servicio apagado, la API limitando el ritmo, un timeout—
 * y no sirve para nada cuando el carril simplemente no sabe leer ese formato.
 * Ofrecer el mismo botón para los dos casos es ofrecer un botón que a veces no
 * hace nada, y eso enseña a desconfiar del botón.
 *
 * Lo declara quien falla, que es el único que sabe. Todo lo demás se asume
 * transitorio: equivocarse hacia "reintenta" solo cuesta una corrida; hacia
 * "no insistas" esconde una memoria para siempre.
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
