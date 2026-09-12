import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackupManifest, BackupSink, BackupSource, Row } from '../../core/ops/backup';
import type { MirrorSink } from '../../core/ops/mirror';

/**
 * The export as a directory. This is the half the core refuses to know about:
 * `core/` never imports `node:fs`, so tables and bytes arrive here as data and
 * become files here and nowhere else.
 *
 *   manifest.json
 *   tables/<name>.jsonl
 *   blobs/<aa>/<bb>/<sha256>
 *
 * JSONL and not one big JSON document: a table is a stream of rows, and a
 * corrupt line costs one row instead of the whole file. Blobs keep the storage
 * key as their path, so what is on disk is laid out exactly like the store it
 * came from — a restore is a copy, not a translation.
 */

const MANIFEST = 'manifest.json';
const TABLES = 'tables';

const write = (path: string, data: string | Buffer): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};

export function fsSink(root: string): BackupSink {
  return {
    async table(name, rows) {
      // A trailing newline on a non-empty file and nothing at all on an empty
      // one, so "no rows" is a zero-byte file rather than a file with one blank
      // line that a reader has to decide about.
      const body = rows.length === 0 ? '' : rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      write(join(root, TABLES, `${name}.jsonl`), body);
    },
    async blob(key, bytes) {
      write(join(root, key), bytes);
    },
    async manifest(m) {
      // Written last by the caller, which makes its presence the signal that the
      // export finished: an interrupted one has no manifest and cannot be read
      // back as if it were whole.
      write(join(root, MANIFEST), JSON.stringify(m, null, 2) + '\n');
    },
  };
}

export function fsSource(root: string): BackupSource {
  return {
    async manifest(): Promise<BackupManifest> {
      return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as BackupManifest;
    },
    async table(name): Promise<readonly Row[]> {
      let text: string;
      try {
        text = readFileSync(join(root, TABLES, `${name}.jsonl`), 'utf8');
      } catch {
        // A table absent from an older export is empty, not broken. The manifest
        // is what decides whether that is a problem.
        return [];
      }
      return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Row);
    },
    async blob(key): Promise<Buffer> {
      return readFileSync(join(root, key));
    },
  };
}

/** The readable copy as a directory. Same trade as `fsSink`: the core hands over
 *  a path and bytes, and only this knows what a filesystem is. */
export function mirrorFsSink(root: string): MirrorSink {
  return {
    async file(path, bytes) {
      write(join(root, path), bytes);
    },
  };
}

/** Bytes on disk under a directory, for reporting what a run actually moved. */
export function dirSize(root: string): number {
  let total = 0;
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  try {
    walk(root);
  } catch {
    return 0;
  }
  return total;
}

/**
 * The secrets, per owner, from the environment and never from the database.
 *
 * Two of them, and they are not interchangeable. The passphrase decrypts the
 * archive and is the one thing that must not live on this host — §14.2's whole
 * argument is that encryption is ceremony when the key is beside the lock, and a
 * passphrase in the database would make a stolen host yield a readable off-site
 * copy. A transport credential merely opens the destination; what is sitting
 * there stays encrypted without it.
 *
 * Per owner because a second owner has a second Nextcloud, with a shared
 * fallback because a one-person system should not have to spell out an id to
 * configure itself.
 */

const suffix = (ownerId: string): string => ownerId.replace(/-/g, '').slice(0, 8).toUpperCase();

/**
 * Empty counts as absent, which is not a nicety.
 *
 * `??` falls through on null and undefined but NOT on '', and a variable
 * declared with no value is the normal state of a half-filled .env.local. Left
 * alone, `status` reported the passphrase as present and restic would have
 * accepted it — a backup encrypted with nothing, reported as configured.
 */
const nonEmpty = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

function resolve(base: string, ownerId: string, env: NodeJS.ProcessEnv): string | null {
  return nonEmpty(env[`${base}_${suffix(ownerId)}`]) ?? nonEmpty(env[base]);
}

export function passphraseFor(ownerId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolve('DM_BACKUP_PASSPHRASE', ownerId, env);
}

/**
 * The variable is named after the transport, not after the abstraction.
 *
 * Only the rclone transports need a credential of ours: for everything restic
 * reaches on its own — B2, S3, R2 — the credentials are restic's own standard
 * variables and pass through untouched. So there is no generic name to invent,
 * and `DM_BACKUP_WEBDAV_PASS` says what it is at the point where you set it.
 */
export function transportSecretFor(
  transport: string,
  ownerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const base = TRANSPORT_ENV[transport];
  return base ? resolve(base, ownerId, env) : null;
}

const TRANSPORT_ENV: Record<string, string | undefined> = {
  webdav: 'DM_BACKUP_WEBDAV_PASS',
};

/** The names to print when one is missing, so the message is actionable. */
export function envNamesFor(what: 'passphrase' | string, ownerId: string): string[] {
  const base = what === 'passphrase' ? 'DM_BACKUP_PASSPHRASE' : TRANSPORT_ENV[what];
  return base ? [`${base}_${suffix(ownerId)}`, base] : [];
}

/** Cheap identity for a directory's contents, used to compare two restores. */
export const digestOf = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
