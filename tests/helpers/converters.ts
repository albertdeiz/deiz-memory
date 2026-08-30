import type { Converter, Converters, ExtractInput } from '../../src/core/ports.js';

export interface FakeConverter extends Converter {
  calls: ExtractInput[];
}

/**
 * Un carril de mentira, para probar el *router* sin markitdown, sin API key y
 * sin whisper. Lo que se prueba acá es la regla de §8.1 —cuál se intenta, cuándo
 * se cae al siguiente— que es lógica del producto; que markitdown sepa leer un
 * docx es problema de markitdown.
 */
export function fakeConverter(
  behaviour: string | ((input: ExtractInput) => string),
  opts: { available?: boolean } = {},
): FakeConverter {
  const calls: ExtractInput[] = [];
  return {
    calls,
    async extract(input) {
      calls.push(input);
      const out = typeof behaviour === 'function' ? behaviour(input) : behaviour;
      if (out.startsWith('throw:')) throw new Error(out.slice(6));
      return { text: out, detail: { tool: 'fake' } };
    },
    async available() {
      return opts.available === false
        ? { ok: false, detail: 'apagado en los tests' }
        : { ok: true, detail: 'fake' };
    },
  };
}

/** Por defecto no hay ningún carril externo: solo el de texto, que es del core. */
export const fakeConverters = (over: Partial<Converters> = {}): Converters => ({
  document: null,
  vision: null,
  audio: null,
  ...over,
});
