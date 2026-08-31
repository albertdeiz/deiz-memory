import type { Actor, Lane, MemorySummary } from '../domain/types.js';
import type { Db, Deps } from '../ports.js';
import { ok, type Result } from '../result.js';
import { MEMORY_COLUMNS, MEMORY_FROM, type MemoryRow, toSummary } from './rows.js';

/**
 * La bandeja de revisión de §3.4.
 *
 * El principio dice que si el sistema duda, guarda igual y deja la duda en una
 * bandeja. Desde F1 la primera mitad funcionaba —la captura nunca se bloquea y
 * el problema queda anotado— pero la bandeja no existía, así que revisar era
 * abrir psql. Esto es la otra mitad.
 */
export interface ReviewItem extends MemorySummary {
  lane: Lane | null;
  error: string;
  /**
   * Si `dm reprocess` puede ayudar. `null` es "no se sabe": son las filas que
   * fallaron antes de que el sistema supiera distinguir, y se resuelve solo la
   * próxima vez que corran.
   */
  retryable: boolean | null;
  /** Lo que igual quedó guardado. Que sea poco es justo lo que hay que mirar. */
  chars: number;
}

export interface ReviewInput {
  limit?: number;
  offset?: number;
}

const clampLimit = (n: number | undefined) =>
  !n || !Number.isFinite(n) ? 20 : Math.min(Math.max(Math.trunc(n), 1), 200);

/**
 * Lo que quedó dudoso, de lo más reciente a lo más viejo.
 *
 * Filtra por dueño como toda consulta del sistema (regla dura 9), y usa el
 * índice parcial `memories_review_idx`, que es parcial porque lo normal es que
 * esta lista esté vacía.
 */
export async function listReview(
  deps: Deps,
  actor: Actor,
  input: ReviewInput = {},
): Promise<Result<ReviewItem[]>> {
  const { rows } = await deps.db.query<
    MemoryRow & { normalization_retryable: boolean | null }
  >(
    `select ${MEMORY_COLUMNS}, m.normalization_retryable ${MEMORY_FROM}
      where m.owner_id = $1 and m.normalization_error is not null
      order by m.captured_at desc
      limit $2 offset $3`,
    [actor.ownerId, clampLimit(input.limit), Math.max(input.offset ?? 0, 0)],
  );

  return ok(
    rows.map((r) => ({
      ...toSummary(r),
      lane: r.normalization_lane as Lane | null,
      error: r.normalization_error ?? '',
      retryable: r.normalization_retryable,
      chars: r.normalized_text?.length ?? 0,
    })),
  );
}

export interface ReviewCounts {
  total: number;
  /** Los que un reproceso podría arreglar. */
  reintentables: number;
  /** Los que necesitan otra cosa: convertir el archivo, o cambiar de carril. */
  necesitanAlgoMas: number;
}

/**
 * Para `dm doctor` y para el chat: el número, sin traerse las filas.
 *
 * Recibe `Db` y no `Deps` —como `listOwners`— porque doctor corre antes de que
 * exista un `Deps` armado, y pedirle uno solo para contar sería inventar
 * ceremonia.
 */
export async function countReview(db: Db, actor: Actor): Promise<ReviewCounts> {
  const { rows } = await db.query<{ total: string; si: string; no: string }>(
    `select count(*)::text total,
            count(*) filter (where normalization_retryable is true)::text si,
            count(*) filter (where normalization_retryable is false)::text no
       from memories
      where owner_id = $1 and normalization_error is not null`,
    [actor.ownerId],
  );
  const r = rows[0]!;
  return {
    total: Number(r.total),
    reintentables: Number(r.si),
    necesitanAlgoMas: Number(r.no),
  };
}
