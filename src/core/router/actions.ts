/**
 * El vocabulario de acciones, compartido entre el botón y el teclado.
 *
 * Esta es la pieza que hace real la degradación de §7.1, y es más simple de lo
 * que parece: **el botón "más" lleva la cadena `mas`, y la persona que no tiene
 * botones escribe `más`**. Las dos cosas producen la misma acción, así que
 * `present.ts` no tiene dos ramas de lógica — tiene dos formas de mostrar la
 * misma lista.
 *
 * Y solo funciona porque el estado vive en `chat_sessions` y no dentro del
 * payload del botón. Si el cursor viajara en el `callback_data`, un canal sin
 * botones no podría reproducirlo: nadie va a tipear un token de 64 bytes.
 */
export type Action =
  | { kind: 'mas' }
  | { kind: 'ver'; n: number }
  | { kind: 'abrir'; n: number }
  | { kind: 'guardar' }
  | { kind: 'ocultar'; n: number }
  | { kind: 'si' }
  | { kind: 'no' };

/** Lo que viaja en un botón. Corto porque Telegram limita a 64 bytes. */
export const encodeAction = (a: Action): string => {
  switch (a.kind) {
    case 'ver': return `ver:${a.n}`;
    case 'abrir': return `abrir:${a.n}`;
    case 'ocultar': return `ocultar:${a.n}`;
    default: return a.kind;
  }
};

/** Sin tildes y en minúsculas: así `más` y `mas` son la misma palabra. */
const normalize = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Palabras que valen por un botón. Se aceptan con y sin tilde porque nadie
 * escribe tildes en un teléfono, y en singular y plural donde tiene sentido.
 */
const WORDS: Record<string, Action> = {
  mas: { kind: 'mas' },
  siguiente: { kind: 'mas' },
  sigue: { kind: 'mas' },
  guardar: { kind: 'guardar' },
  guardalo: { kind: 'guardar' },
  si: { kind: 'si' },
  ok: { kind: 'si' },
  dale: { kind: 'si' },
  no: { kind: 'no' },
  cancelar: { kind: 'no' },
};

/**
 * Interpreta una acción, venga de un botón o del teclado.
 *
 * `hasPending` importa: sin una lista en pantalla, un `3` suelto no es "ver el
 * tercero", es alguien capturando el número 3. Confundirlos perdería el dato,
 * y §5 dice que perder es lo caro.
 */
export function parseAction(raw: string | null, hasPending: boolean): Action | null {
  if (!raw) return null;
  const s = normalize(raw);
  if (!s) return null;

  const numbered = /^(ver|abrir|ocultar):(\d{1,2})$/.exec(s);
  if (numbered) {
    const n = Number(numbered[2]);
    return n >= 1 && n <= 99 ? { kind: numbered[1] as 'ver' | 'abrir' | 'ocultar', n } : null;
  }

  const word = WORDS[s];
  if (word) return word;

  // Un número pelado solo significa algo si hay una lista esperando.
  if (hasPending && /^\d{1,2}$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n <= 99) return { kind: 'ver', n };
  }

  return null;
}
