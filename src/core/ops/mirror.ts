import type { Actor, Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import { meaningfulName } from '../filenames';
import { extensionForMediaType } from '../media';
import type { Deps } from '../ports';
import { ok, type Result } from '../result';

/**
 * A readable copy of the originals — a different thing from a backup, and its
 * own file so nobody has to remember that.
 *
 * The backup is opaque on purpose: restic packs, encrypted and deduplicated,
 * unreadable without the passphrase. That is right for surviving a disaster and
 * useless for what §6.1 admits the chat cannot do — look at four hundred
 * documents. So this writes the same originals under names a person can read.
 *
 * Three rules keep it from becoming a second source of truth, which is the only
 * way a mirror can hurt you:
 *
 *  1 · It is DERIVED. Everything here is regenerated from the database and the
 *      blobs (§3.6); nothing is ever read back in.
 *  2 · It is ONE-WAY. Editing or deleting in the mirror changes nothing, and the
 *      next run puts the file back. The system never learns from it.
 *  3 · It lives SEPARATE from the repository. Two folders, never one — a restic
 *      repo and a readable tree in the same directory would be a mess that only
 *      looks like it works.
 *
 * And it is not the product becoming a Drive (§2): the chat is still the only
 * way in. This is an export, and an export is not an interface.
 */

export interface MirrorSink {
  file(path: string, bytes: Buffer): Promise<void>;
}

export interface MirrorEntry {
  path: string;
  storageKey: string;
}

interface MirrorRow {
  id: Uuid;
  title: string | null;
  original_filename: string | null;
  occurred_at: Date | null;
  captured_at: Date;
  media_type: string | null;
  storage_key: string | null;
  domain_label: string | null;
}

/** Characters no filesystem, and no Nextcloud, will take in a name. */
const FORBIDDEN = new RegExp('[<>:"|?*\\u0000-\\u001f]', 'g');

/**
 * A path segment that survives every filesystem.
 *
 * Slashes go first and separately: a title carrying a date like `03/2026` would
 * otherwise turn into a directory, quietly, and the file would land somewhere
 * nobody looks.
 */
const safeSegment = (raw: string, fallback: string): string => {
  const cleaned = raw
    .replace(/[/\\]/g, '-')
    .replace(FORBIDDEN, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot hides the file; a trailing dot or space is what Windows
    // refuses and what syncs then fail on, one file at a time.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 90)
    .trim();
  return cleaned || fallback;
};

/**
 * Where each original goes.
 *
 * Domain first, then the date of the FACT and not of the capture: §3.3 says the
 * timeline that matters is when it happened, and a folder sorted by when you got
 * around to scanning something is a folder nobody can read.
 */
export async function planMirror(deps: Deps, actor: Actor): Promise<Result<MirrorEntry[]>> {
  const { rows } = await deps.db.query<MirrorRow>(
    `select m.id, m.title, m.original_filename, m.occurred_at, m.captured_at,
            b.media_type, b.storage_key, d.label as domain_label
       from memories m
       join blobs b on b.sha256 = m.blob_sha256
       left join domains d on d.id = m.domain_id
      where m.owner_id = $1 and not m.hidden
      order by coalesce(m.occurred_at, m.captured_at)`,
    [actor.ownerId],
  );

  const used = new Set<string>();
  const plan: MirrorEntry[] = [];

  for (const r of rows) {
    if (!r.storage_key) continue;

    const domain = safeSegment(r.domain_label ?? 'Sin categoría', 'Sin categoría');
    const when = (r.occurred_at ?? r.captured_at).toISOString().slice(0, 10);
    const name = safeSegment(
      r.title ?? meaningfulName(r.original_filename) ?? 'Sin título',
      'Sin título',
    );
    const ext = r.media_type ? extensionForMediaType(r.media_type) : '';
    const suffix = ext ? `.${ext}` : '';

    // Two memories can legitimately share a domain, a date and a title. Letting
    // one overwrite the other would lose a document silently, so the loser gets
    // the short id — the same one `dm show` takes, so a file found here can be
    // traced back to its memory.
    let path = `${domain}/${when} · ${name}${suffix}`;
    if (used.has(path)) path = `${domain}/${when} · ${name} (${shortId(r.id)})${suffix}`;
    used.add(path);

    plan.push({ path, storageKey: r.storage_key });
  }

  return ok(plan);
}

/**
 * Writes the readable copy. The core still does not know what a file is: paths
 * and bytes go to a sink, and the adapter is what turns them into a directory.
 *
 * Hidden memories are left out by `planMirror`. That is the honest reading of
 * `hidden` (§4): out of results means out of sight, and a folder is the most
 * visible place there is.
 */
export async function mirrorOwner(
  deps: Deps,
  actor: Actor,
  sink: MirrorSink,
): Promise<Result<{ files: number; bytes: number }>> {
  const planned = await planMirror(deps, actor);
  if (!planned.ok) return planned;

  let bytes = 0;
  for (const entry of planned.value) {
    const buf = await deps.blobs.get(entry.storageKey);
    await sink.file(entry.path, buf);
    bytes += buf.byteLength;
  }
  return ok({ files: planned.value.length, bytes });
}
