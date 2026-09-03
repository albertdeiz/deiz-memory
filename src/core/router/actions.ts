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
  /** El archivo de la memoria que estás viendo. Sin número: no es de una lista. */
  | { kind: 'original' }
  | { kind: 'guardar' }
  | { kind: 'ocultar'; n: number }
  | { kind: 'si' }
  | { kind: 'no' };

/**
 * Lo que viaja en un botón. Corto porque Telegram limita a 64 bytes.
 *
 * En inglés y con los nombres del CLI: `view` es `dm show`, `open` es `dm open`,
 * `hide` es `dm hide`. Un solo nombre por acción: dos formas de decir lo mismo
 * es una que hay que mantener sincronizada con la otra para siempre.
 */
export const encodeAction = (a: Action): string => {
  switch (a.kind) {
    case 'ver': return `view:${a.n}`;
    case 'abrir': return `open:${a.n}`;
    case 'ocultar': return `hide:${a.n}`;
    case 'mas': return 'more';
    case 'guardar': return 'save';
    case 'si': return 'yes';
    case 'no': return 'no';
    default: return a.kind;
  }
};

/** En minúsculas y sin tildes: nadie escribe tildes en un teléfono. */
const normalize = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Palabras que valen por un botón. En inglés, como los comandos. */
const WORDS: Record<string, Action> = {
  more: { kind: 'mas' },
  save: { kind: 'guardar' },
  original: { kind: 'original' },
  yes: { kind: 'si' },
  no: { kind: 'no' },
};

/** Las acciones que llevan número. La cadena es la misma del botón. */
const NUMBERED: Record<string, 'ver' | 'abrir' | 'ocultar'> = {
  view: 'ver',
  open: 'abrir',
  hide: 'ocultar',
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

  const numbered = /^([a-z]+)[:\s](\d{1,2})$/.exec(s);
  if (numbered) {
    const kind = NUMBERED[numbered[1]!];
    const n = Number(numbered[2]);
    if (kind && n >= 1 && n <= 99) return { kind, n };
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
