import type { Converter, Converters, ExtractInput } from '../../src/core/ports';

export interface FakeConverter extends Converter {
  calls: ExtractInput[];
}

/**
 * A fake lane, to test the *router* with no converter service, no API key and no
 * speech server. What is tested here is the rule — which lane is tried, when it
 * falls to the next — which is product logic; whether a converter can read a
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

/** By default there is no external lane: only the text one, which is the core's. */
export const fakeConverters = (over: Partial<Converters> = {}): Converters => ({
  document: null,
  vision: null,
  audio: null,
  ...over,
});
