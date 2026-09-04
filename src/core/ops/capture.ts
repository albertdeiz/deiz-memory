import { createHash } from 'node:crypto';
import type { Actor, Source, Uuid } from '../domain/types';
import { SOURCES, shortId } from '../domain/types';
import { detectMediaType } from '../media';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { storageKey } from './rows';

export interface CaptureInput {
  bytes?: Buffer | null;
  text?: string | null;
  filename?: string | null;
  title?: string | null;
  occurredAt?: Date | null;
  source?: Source;
}

export interface CaptureResult {
  id: Uuid;
  shortId: string;
  sha256: string | null;
  deduped: boolean;
  mediaType: string | null;
  sizeBytes: number | null;
}

/**
 * Retorna apenas el blob está persistido y la memoria insertada — no espera a
 * que los carriles corran. Ese acuse ya decía lo correcto en F0 y ahora
 * *significa* algo: detrás hay un OCR que puede tardar diez segundos.
 *
 * Lo que la persona escribió va a `note` y lo que se extraiga del archivo irá a
 * `normalized_text`. Nunca al revés y nunca juntos: la nota no se regenera, y
 * la primera transcripción se la comería (ver migración 003).
 */
export async function capture(
  deps: Deps,
  actor: Actor,
  input: CaptureInput,
): Promise<Result<CaptureResult>> {
  const bytes = input.bytes && input.bytes.length > 0 ? input.bytes : null;
  const text = input.text?.trim() ? input.text.trim() : null;

  if (!bytes && !text) {
    return err('invalid', 'No hay nada que capturar: pasa un archivo, --text o stdin.');
  }

  const source: Source = input.source ?? 'cli';
  if (!SOURCES.includes(source)) {
    return err('invalid', `source inválido: "${source}". Válidos: ${SOURCES.join(', ')}.`);
  }

  const owner = await deps.db.query(`select 1 from owners where id = $1`, [actor.ownerId]);
  if (owner.rowCount === 0) {
    return err('forbidden', `El actor ${actor.ownerId} no existe. Corre "dm init" primero.`);
  }

  let sha256: string | null = null;
  let mediaType: string | null = null;
  let sizeBytes: number | null = null;
  let deduped = false;

  if (bytes) {
    sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = await deps.db.query<{ media_type: string; size_bytes: string }>(
      `select media_type, size_bytes from blobs where sha256 = $1`,
      [sha256],
    );

    if (existing.rowCount > 0) {
      // Direccionable por contenido: mismo archivo, mismo blob. Solo nace otra memoria.
      deduped = true;
      mediaType = existing.rows[0]!.media_type;
      sizeBytes = Number(existing.rows[0]!.size_bytes);
    } else {
      mediaType = detectMediaType(bytes, input.filename);
      sizeBytes = bytes.length;
      // Subir ANTES de insertar: nunca una fila apuntando a un objeto que no existe.
      // Al revés dejaría huérfano un objeto, que es recuperable; esto no lo sería.
      await deps.blobs.put(storageKey(sha256), bytes, mediaType);
      await deps.db.query(
        `insert into blobs (sha256, size_bytes, media_type, storage_key)
         values ($1, $2, $3, $4) on conflict (sha256) do nothing`,
        [sha256, sizeBytes, mediaType, storageKey(sha256)],
      );
    }
  }

  const { rows } = await deps.db.query<{ id: string }>(
    `insert into memories
       (owner_id, source, captured_at, occurred_at, blob_sha256,
        original_filename, title, note, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'raw')
     returning id`,
    [
      actor.ownerId,
      source,
      deps.clock.now(),
      input.occurredAt ?? null,
      sha256,
      input.filename ?? null,
      input.title ?? null,
      text,
    ],
  );

  const id = rows[0]!.id;
  await deps.ingest.process(id);

  return ok({ id, shortId: shortId(id), sha256, deduped, mediaType, sizeBytes });
}
