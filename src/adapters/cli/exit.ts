import type { Result } from '../../core/result';

/**
 * The exit code is what makes the CLI testable without reading prose.
 * It is also the contract an HTTP adapter would map to status codes.
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
