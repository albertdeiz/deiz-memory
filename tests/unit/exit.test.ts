import { describe, expect, it } from 'vitest';
import { EXIT, exitCodeFor } from '../../src/adapters/cli/exit';
import { err, needsConfirmation, ok } from '../../src/core/result';

describe('exitCodeFor', () => {
  it('mapea cada resultado a un código distinguible por un script', () => {
    expect(exitCodeFor(ok(1))).toBe(EXIT.ok);
    expect(exitCodeFor(needsConfirmation('¿seguro?', []))).toBe(EXIT.needsConfirmation);
    expect(exitCodeFor(err('not_found', 'x'))).toBe(EXIT.notFound);
    expect(exitCodeFor(err('forbidden', 'x'))).toBe(EXIT.forbidden);
    expect(exitCodeFor(err('ambiguous', 'x'))).toBe(EXIT.ambiguous);
    expect(exitCodeFor(err('invalid', 'x'))).toBe(EXIT.error);
  });

  it('confirmación pendiente no es 0: un script no puede confundirla con éxito', () => {
    expect(exitCodeFor(needsConfirmation('x', []))).not.toBe(EXIT.ok);
  });
});
