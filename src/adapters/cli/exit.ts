import type { Result } from '../../core/result.js';

/**
 * El código de salida es lo que hace testeable el CLI sin leer prosa.
 * Es también el contrato que un adapter HTTP mapeará a status codes.
 */
export const EXIT = {
  ok: 0,
  error: 1,
  needsConfirmation: 2,
  notFound: 3,
  forbidden: 4,
  ambiguous: 5,
} as const;

export function exitCodeFor(result: Result<unknown>): number {
  if (result.ok) return EXIT.ok;
  switch (result.kind) {
    case 'requires_confirmation': return EXIT.needsConfirmation;
    case 'not_found':             return EXIT.notFound;
    case 'forbidden':             return EXIT.forbidden;
    case 'ambiguous':             return EXIT.ambiguous;
    default:                      return EXIT.error;
  }
}
