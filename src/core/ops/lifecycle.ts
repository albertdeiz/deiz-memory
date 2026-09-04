import type { Actor, Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import { meaningfulName } from '../filenames';
import type { Deps } from '../ports';
import { err, needsConfirmation, ok, type Result } from '../result';
import { resolveMemoryId } from './resolve';
import { show } from './query';

export interface HideResult {
  id: Uuid;
  shortId: string;
  hidden: boolean;
}

/** Hiding is a flag, never a delete: the store is append-only. */
export async function setHidden(
  deps: Deps,
  actor: Actor,
  ref: string,
  hidden: boolean,
): Promise<Result<HideResult>> {
  const resolved = await resolveMemoryId(deps.db, actor, ref);
  if (!resolved.ok) return resolved;

  const { rowCount } = await deps.db.query(
    `update memories set hidden = $3, updated_at = now() where id = $1 and owner_id = $2`,
    [resolved.value, actor.ownerId, hidden],
  );
  if (rowCount === 0) return err('not_found', `No existe la memoria ${ref}.`);
  return ok({ id: resolved.value, shortId: shortId(resolved.value), hidden });
}

export interface PurgeResult {
  id: Uuid;
  shortId: string;
  blobDeleted: boolean;
}

/**
 * The only way to truly delete. Explicit, confirmed and audited.
 * The blob only goes if no other memory references it.
 */
export async function purge(
  deps: Deps,
  actor: Actor,
  ref: string,
  opts: { confirm: boolean },
): Promise<Result<PurgeResult>> {
  const detail = await show(deps, actor, ref);
  if (!detail.ok) return detail;
  const m = detail.value;

  if (!opts.confirm) {
    const label = m.title ?? meaningfulName(m.originalFilename) ?? m.excerpt ?? '(sin título)';
    return needsConfirmation(
      `Purgar borra "${label}" para siempre y no hay forma de recuperarla. ` +
        `Ocultar (dm hide) la saca de los resultados sin destruirla.`,
      [{ kind: 'memory', id: m.id, label }],
    );
  }

  const { storageKeyToDrop } = await deps.db.tx(async (tx) => {
    const deleted = await tx.query<{ blob_sha256: string | null }>(
      `delete from memories where id = $1 and owner_id = $2 returning blob_sha256`,
      [m.id, actor.ownerId],
    );
    if (deleted.rowCount === 0) throw new Error(`memoria ${m.id} desapareció durante el purge`);

    const sha = deleted.rows[0]!.blob_sha256;
    let key: string | null = null;

    if (sha) {
      const still = await tx.query<{ n: string }>(
        `select count(*)::text as n from memories where blob_sha256 = $1`,
        [sha],
      );
      if (Number(still.rows[0]!.n) === 0) {
        const dropped = await tx.query<{ storage_key: string }>(
          `delete from blobs where sha256 = $1 returning storage_key`,
          [sha],
        );
        key = dropped.rows[0]?.storage_key ?? null;
      }
    }

    await tx.query(
      `insert into audit_log (owner_id, action, subject_id, detail) values ($1, 'purge', $2, $3)`,
      [
        actor.ownerId,
        m.id,
        JSON.stringify({
          title: m.title,
          filename: m.originalFilename,
          sha256: sha,
          blobDeleted: key !== null,
          capturedAt: m.capturedAt,
        }),
      ],
    );

    return { storageKeyToDrop: key };
  });

  // Outside the transaction on purpose: an object-store delete cannot be rolled
  // back. If this fails an orphan object remains, which is harmless and
  // recoverable.
  if (storageKeyToDrop) await deps.blobs.delete(storageKeyToDrop);

  return { ok: true, value: { id: m.id, shortId: m.shortId, blobDeleted: storageKeyToDrop !== null } };
}
