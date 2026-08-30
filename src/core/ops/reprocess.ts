import type { Actor, Lane, Uuid } from '../domain/types.js';
import { shortId } from '../domain/types.js';
import type { Deps } from '../ports.js';
import { err, needsConfirmation, ok, type Result } from '../result.js';
import { resolveMemoryId } from './resolve.js';

export interface ReprocessInput {
  /** Una memoria concreta. Excluye a los demás selectores. */
  ref?: string | null;
  /** Las que fallaron o quedaron a medias. El selector que vas a usar siempre. */
  failed?: boolean;
  /** Las que nunca pasaron por un carril. */
  pending?: boolean;
  /** Todas las que tienen archivo. Para cuando mejora el prompt. */
  all?: boolean;
  /** Acota a un carril: "solo las fotos". */
  lane?: Lane | null;
  limit?: number;
  confirm?: boolean;
}

export interface ReprocessResult {
  queued: number;
  ids: Uuid[];
  /** Los mismos, en prefijo, para mostrar. `ids` promete uuid y tiene que cumplirlo. */
  shortIds: string[];
}

// Number('abc') es NaN, y NaN sobrevive a Math.min/Math.max sin inmutarse: sin
// esta guarda termina en un `limit $1` y Postgres devuelve un error de sintaxis
// crudo en vez de un mensaje útil.
const clampLimit = (n: number | undefined) =>
  !n || !Number.isFinite(n) ? 100 : Math.min(Math.max(Math.trunc(n), 1), 5_000);

/**
 * UC-15. Todo lo derivado es regenerable desde el blob, y esta es la puerta:
 * mejoras el prompt del carril de visión y vuelves a pasar el histórico entero.
 *
 * No es destructivo —el original no se toca y por eso se puede— pero sí cuesta
 * plata: el carril de visión se paga por token. Por eso en lote pide `--yes`,
 * igual que purge, aunque por una razón completamente distinta.
 */
export async function reprocess(
  deps: Deps,
  actor: Actor,
  input: ReprocessInput,
): Promise<Result<ReprocessResult>> {
  let ids: Uuid[];

  if (input.ref) {
    const resolved = await resolveMemoryId(deps.db, actor, input.ref);
    if (!resolved.ok) return resolved;
    ids = [resolved.value];
  } else {
    const where: string[] = ['m.owner_id = $1', 'm.blob_sha256 is not null'];
    const params: unknown[] = [actor.ownerId];

    if (input.failed) where.push('m.normalization_error is not null');
    if (input.pending) where.push('m.normalized_at is null');
    if (input.lane) {
      params.push(input.lane);
      where.push(`m.normalization_lane = $${params.length}`);
    }

    // Sin selector esto reprocesaría la biblioteca completa porque sí. Exigir
    // que digas cuál es más barato que explicarte después la factura.
    if (!input.failed && !input.pending && !input.lane && !input.all) {
      return err(
        'invalid',
        'Dime qué reprocesar: un id, o --failed, --pending, --lane <carril> o --all.',
      );
    }

    // Los selectores se combinan con AND, y dos de esas combinaciones no pueden
    // dar nada nunca: lo pendiente todavía no tiene carril, y lo fallido ya
    // corrió. Devolver "no hay nada que reprocesar" sería peor que un error —
    // dirías "ah, entonces está todo bien" y te irías tranquilo.
    if (input.pending && input.lane) {
      return err('invalid', 'Lo pendiente todavía no tiene carril asignado: --pending y --lane se excluyen.');
    }
    if (input.pending && input.failed) {
      return err('invalid', 'Lo fallido ya corrió y lo pendiente no: --pending y --failed se excluyen.');
    }

    params.push(clampLimit(input.limit));
    const { rows } = await deps.db.query<{ id: string }>(
      `select m.id from memories m
        where ${where.join(' and ')}
        order by m.captured_at desc
        limit $${params.length}`,
      params,
    );
    ids = rows.map((r) => r.id);
  }

  if (ids.length === 0) return ok({ queued: 0, ids: [], shortIds: [] });

  if (ids.length > 1 && !input.confirm) {
    return needsConfirmation(
      `Reprocesar ${ids.length} memorias vuelve a correr los carriles sobre cada original. ` +
        'No se pierde nada —el archivo no se toca— pero el carril de visión se paga por token.',
      [{ kind: 'memories', id: `${ids.length}`, label: `${ids.length} memorias` }],
    );
  }

  for (const id of ids) await deps.ingest.process(id);

  return ok({ queued: ids.length, ids, shortIds: ids.map(shortId) });
}
