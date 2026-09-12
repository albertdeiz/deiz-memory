import { createHash } from 'node:crypto';
import type { Actor, Uuid } from '../domain/types';
import type { Db, Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { storageKey } from './rows';

/**
 * The backup, produced by the core and not by a script.
 *
 * A backup is of a PERSON, not of "the system". Two owners in one snapshot would
 * hand each of them the other's data at restore time, which is what hard rule 9
 * exists to prevent — and a restore is not where anyone wants to find out the
 * rule only ever covered queries. So there is no "dump everything" path here:
 * every statement carries `where owner_id`, and it carries it in TypeScript
 * because bash is the one place in this system where that rule would not be
 * checked by anything.
 *
 * The core still does not know what a file is: it hands rows and bytes to a
 * sink, and the CLI adapter is what turns those into a directory. Same trade the
 * `BlobStore` port already pays for — the in-memory sink is what lets this be
 * tested without a filesystem.
 */

/** Where an export is written. Implemented by the adapter that owns the files. */
export interface BackupSink {
  table(name: string, rows: readonly unknown[]): Promise<void>;
  blob(key: string, bytes: Buffer): Promise<void>;
  manifest(m: BackupManifest): Promise<void>;
}

/** Where an export is read back from, for verification and restore. */
export interface BackupSource {
  manifest(): Promise<BackupManifest>;
  table(name: string): Promise<readonly Row[]>;
  blob(key: string): Promise<Buffer>;
}

export type Row = Record<string, unknown>;

export interface BackupManifest {
  /** Bumped when the shape changes, so a restore can refuse what it cannot read. */
  version: 1;
  ownerId: Uuid;
  createdAt: string;
  /** Rows per table, which is what verification counts against. */
  tables: Record<string, number>;
  blobs: { count: number; bytes: number };
}

interface TableSpec {
  name: string;
  /** The FROM clause when ownership is not a column on the table itself. */
  from?: string;
  /** Always parameterised on the owner. There is deliberately no unfiltered form. */
  where: string;
  order?: string;
  /** Prefix for the column list, when the FROM is a join. */
  as?: string;
}

/**
 * What travels, parents before children so a restore can insert in order.
 *
 * `blobs` is the interesting one. It has no `owner_id` (§14.1: dedup by content
 * and partition by owner exclude each other), so ownership is only readable
 * through the memories that reference it — hence the join, and hence the
 * `distinct`, because two memories of the same file are one blob.
 */
const TABLES: readonly TableSpec[] = [
  { name: 'owners', where: 'id = $1' },
  { name: 'domains', where: 'owner_id = $1', order: 'created_at' },
  { name: 'fact_types', where: 'owner_id = $1', order: 'created_at' },
  {
    name: 'blobs',
    as: 'b',
    from: 'blobs b join memories m on m.blob_sha256 = b.sha256',
    where: 'm.owner_id = $1',
  },
  { name: 'memories', where: 'owner_id = $1', order: 'captured_at' },
  { name: 'memory_chunks', where: 'owner_id = $1', order: 'memory_id, seq' },
  { name: 'facts', where: 'owner_id = $1', order: 'extracted_at' },
  { name: 'channel_identities', where: 'owner_id = $1', order: 'linked_at' },
  { name: 'audit_log', where: 'owner_id = $1', order: 'at' },
];

/**
 * Two tables stay behind, and it is a decision rather than an oversight.
 *
 * `pairing_codes` are single-use and expire in fifteen minutes, and
 * `chat_sessions` hold the cursor of the last list shown. Restoring either would
 * restore something already meaningless. `backup_config` names the destination,
 * which belongs to the host doing the restoring and not to the snapshot, and
 * `schema_migrations` is rebuilt by running the migrations.
 */
export const NOT_BACKED_UP: readonly string[] = ['pairing_codes', 'chat_sessions', 'schema_migrations', 'backup_config'];

/**
 * The columns, read from the catalogue instead of written down here.
 *
 * `select *` looks like the obvious thing and is wrong: `memories.search_tsv` is
 * GENERATED ALWAYS, so it would be exported for nothing and then refused on
 * insert at restore time — a backup that only fails when you finally need it.
 * Asking the database which columns are real means a generated column added
 * later cannot reintroduce that.
 */
async function realColumns(db: Db, table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER'
      order by ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

const selectFor = (t: TableSpec, cols: readonly string[]): string => {
  const prefix = t.as ? `${t.as}.` : '';
  const list = cols.map((c) => `${prefix}"${c}"`).join(', ');
  const distinct = t.from ? 'distinct ' : '';
  const order = t.order ? ` order by ${t.order}` : '';
  return `select ${distinct}${list} from ${t.from ?? t.name} where ${t.where}${order}`;
};

export const BACKED_UP_TABLES: readonly string[] = TABLES.map((t) => t.name);

/** Writes one owner's whole world into the sink. */
export async function exportOwner(
  deps: Deps,
  actor: Actor,
  sink: BackupSink,
): Promise<Result<BackupManifest>> {
  const tables: Record<string, number> = {};
  let blobRows: readonly Row[] = [];

  for (const t of TABLES) {
    const cols = await realColumns(deps.db, t.name);
    const { rows } = await deps.db.query<Row>(selectFor(t, cols), [actor.ownerId]);
    await sink.table(t.name, rows);
    tables[t.name] = rows.length;
    if (t.name === 'blobs') blobRows = rows;
  }

  // The bytes, through the port that already exists. Enumerated from the rows
  // just exported and not from a listing of the store, so what lands is exactly
  // what this owner's memories reference — never a neighbour's file.
  let bytes = 0;
  for (const b of blobRows) {
    const key = String(b['storage_key'] ?? storageKey(String(b['sha256'])));
    const buf = await deps.blobs.get(key);
    await sink.blob(key, buf);
    bytes += buf.byteLength;
  }

  const manifest: BackupManifest = {
    version: 1,
    ownerId: actor.ownerId,
    createdAt: deps.clock.now().toISOString(),
    tables,
    blobs: { count: blobRows.length, bytes },
  };
  await sink.manifest(manifest);
  return ok(manifest);
}

export interface CheckReport {
  manifest: BackupManifest;
  /** Rows actually found, against what the manifest claims. */
  counted: Record<string, number>;
  blobsHashed: number;
  problems: string[];
}

/**
 * Reads an export back and looks for the ways THIS design can be wrong.
 *
 * Not "is the archive intact" — restic answers that. The failure mode of a
 * per-owner filtered export is a dangling reference: a memory whose blob was
 * never copied because the join missed it. So the checks are the cross-ones, plus
 * a re-hash of every blob, which costs nothing here because the filename IS the
 * sha256 and would cost a stored checksum in any other design.
 */
export async function checkExport(source: BackupSource): Promise<Result<CheckReport>> {
  const manifest = await source.manifest();
  if (manifest.version !== 1) {
    return err('invalid', `respaldo en versión ${manifest.version}, esta versión lee 1.`);
  }

  const problems: string[] = [];
  const counted: Record<string, number> = {};
  const rowsOf: Record<string, readonly Row[]> = {};

  for (const name of BACKED_UP_TABLES) {
    const rows = await source.table(name);
    rowsOf[name] = rows;
    counted[name] = rows.length;
    const claimed = manifest.tables[name];
    if (claimed !== undefined && claimed !== rows.length) {
      problems.push(`${name}: el manifiesto dice ${claimed} filas y hay ${rows.length}`);
    }
  }

  // Every owner_id present has to be the one this backup is of. This is the
  // check that would catch a filter quietly going missing from one statement.
  for (const name of BACKED_UP_TABLES) {
    if (name === 'owners' || name === 'blobs') continue;
    for (const r of rowsOf[name] ?? []) {
      if (r['owner_id'] && r['owner_id'] !== manifest.ownerId) {
        problems.push(`${name}: trae filas de otro dueño (${String(r['owner_id'])})`);
        break;
      }
    }
  }

  const blobBySha = new Map((rowsOf['blobs'] ?? []).map((b) => [String(b['sha256']), b]));

  // A memory pointing at a blob that did not travel is the dangling reference
  // this whole check exists for: at restore time it is a row promising a file
  // that is not there, which §7.1 already calls worse than not having the row.
  for (const m of rowsOf['memories'] ?? []) {
    const sha = m['blob_sha256'];
    if (sha && !blobBySha.has(String(sha))) {
      problems.push(`memoria ${String(m['id'])} referencia el blob ${String(sha)}, que no está en el respaldo`);
    }
  }

  let blobsHashed = 0;
  for (const [sha, b] of blobBySha) {
    const key = String(b['storage_key'] ?? storageKey(sha));
    let buf: Buffer;
    try {
      buf = await source.blob(key);
    } catch {
      problems.push(`falta el archivo del blob ${sha}`);
      continue;
    }
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== sha) problems.push(`el blob ${sha} no coincide con su contenido (${got})`);
    blobsHashed += 1;
  }

  return ok({ manifest, counted, blobsHashed, problems });
}

/**
 * Loads an export into a database, which is the only thing that proves it
 * restores. Takes a `Db` and not `Deps` on purpose: it is pointed at a throwaway
 * database, never at the live one, and there is no owner being exposed to
 * anybody — the caller already holds the whole backup.
 */
export async function importInto(db: Db, source: BackupSource): Promise<Result<Record<string, number>>> {
  const manifest = await source.manifest();
  if (manifest.version !== 1) {
    return err('invalid', `respaldo en versión ${manifest.version}, esta versión lee 1.`);
  }

  const loaded: Record<string, number> = {};
  for (const name of BACKED_UP_TABLES) {
    const rows = await source.table(name);
    const jsonCols = await jsonColumns(db, name);
    for (const row of rows) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const quoted = cols.map((c) => `"${c}"`).join(', ');
      await db.query(
        `insert into ${name} (${quoted}) values (${placeholders})`,
        cols.map((c) => encodeParam(row[c], jsonCols.has(c))),
      );
    }
    loaded[name] = rows.length;
  }
  return ok(loaded);
}

/**
 * Which columns are json, because the driver cannot tell and gets it backwards.
 *
 * A JS array bound to a parameter becomes a Postgres ARRAY literal, which is
 * right for `memories.tags` (text[]) and wrong for `fact_types.fields`, a jsonb
 * column whose value happens to be an array — Postgres then rejects `{...}` as
 * invalid json. The two cases are indistinguishable from the value alone, so the
 * column type has to be asked for.
 */
async function jsonColumns(db: Db, table: string): Promise<Set<string>> {
  const { rows } = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 and udt_name in ('json', 'jsonb')`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

/** json goes as text and Postgres parses it; everything else the driver handles. */
const encodeParam = (value: unknown, isJson: boolean): unknown =>
  isJson && value !== null && value !== undefined ? JSON.stringify(value) : value;

// ------------------------------------------------------------------ config

/**
 * Where a destination lives, and where it does not.
 *
 * The split is not squeamishness, it is the threat model. An address is data:
 * per owner, editable, and useless to anyone who reads it — so it goes in the
 * table, where `dm backup set` writes it and `dm backup status` reads it (§14.3).
 * A secret is what makes
 * the address usable, and the two secrets here are not even the same kind:
 *
 *  · The transport credential opens the destination. If it leaks, someone can
 *    write to your folder — but what is sitting there is still encrypted.
 *  · The passphrase decrypts the archive. It is the ONE thing that must not be
 *    on this host, because §14.2's whole argument is that on-host encryption is
 *    ceremony when the key is beside the lock. Put it in the database and a
 *    stolen host yields a readable off-site archive, which is the exact failure
 *    the off-site copy exists to survive.
 *
 * So both are resolved per owner from the environment and neither is ever
 * written. The only thing anything can say about them is whether they are there.
 */
export type Transport = 'none' | 'webdav';

export const TRANSPORTS: readonly Transport[] = ['none', 'webdav'];

/** The non-secret half of reaching a destination, per transport. */
export interface WebdavConfig {
  url: string;
  user: string;
}

export interface BackupConfig {
  ownerId: Uuid;
  repository: string;
  transport: Transport;
  transportConfig: Record<string, unknown>;
  /** Where the readable copy goes. Null means there is not one. */
  mirrorPath: string | null;
  lastRunAt: Date | null;
  lastSnapshotId: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastVerifiedAt: Date | null;
}

interface ConfigRow {
  owner_id: Uuid;
  repository: string;
  transport: string;
  transport_config: Record<string, unknown>;
  mirror_path: string | null;
  last_run_at: Date | null;
  last_snapshot_id: string | null;
  last_ok: boolean | null;
  last_error: string | null;
  last_verified_at: Date | null;
}

const toConfig = (r: ConfigRow): BackupConfig => ({
  ownerId: r.owner_id,
  repository: r.repository,
  transport: (TRANSPORTS as readonly string[]).includes(r.transport)
    ? (r.transport as Transport)
    : 'none',
  transportConfig: r.transport_config ?? {},
  mirrorPath: r.mirror_path,
  lastRunAt: r.last_run_at,
  lastSnapshotId: r.last_snapshot_id,
  lastOk: r.last_ok,
  lastError: r.last_error,
  lastVerifiedAt: r.last_verified_at,
});

/** Null and not an error: a destination nobody set yet is a state, not a fault. */
export async function readBackupConfig(deps: Deps, actor: Actor): Promise<Result<BackupConfig | null>> {
  const { rows } = await deps.db.query<ConfigRow>(
    `select * from backup_config where owner_id = $1`,
    [actor.ownerId],
  );
  return ok(rows[0] ? toConfig(rows[0]) : null);
}

export interface Destination {
  repository: string;
  transport?: Transport;
  transportConfig?: Record<string, unknown>;
}

/**
 * Sets where this owner's backup goes.
 *
 * Validated here rather than at the column, because what a transport needs is
 * known by the code that builds it: a `webdav` destination without a URL is not
 * a row to store and reject later, it is a mistake to refuse now.
 */
export async function setBackupDestination(
  deps: Deps,
  actor: Actor,
  d: Destination,
): Promise<Result<BackupConfig>> {
  const repo = d.repository.trim();
  if (!repo) return err('invalid', 'El repositorio no puede ser vacío.');

  const transport = d.transport ?? 'none';
  if (!TRANSPORTS.includes(transport)) {
    return err('invalid', `Transporte desconocido: ${transport}. Hay ${TRANSPORTS.join(' · ')}.`);
  }

  const cfg = d.transportConfig ?? {};
  if (transport === 'webdav') {
    const url = String(cfg.url ?? '').trim();
    const user = String(cfg.user ?? '').trim();
    if (!url) return err('invalid', 'Un destino webdav necesita la URL del endpoint.');
    if (!user) return err('invalid', 'Un destino webdav necesita el usuario.');
    // The browser URL is the mistake everyone makes once, and it fails as an
    // opaque auth error hours later. Saying so now costs nothing.
    if (!/\/remote\.php\/dav\//.test(url)) {
      return err('invalid',
        'Esa no parece la URL de WebDAV. Tiene que llevar /remote.php/dav/files/<usuario>/, no la del navegador.');
    }
  }

  const { rows } = await deps.db.query<ConfigRow>(
    `insert into backup_config (owner_id, repository, transport, transport_config)
     values ($1, $2, $3, $4)
     on conflict (owner_id) do update
       set repository = $2, transport = $3, transport_config = $4, updated_at = now()
     returning *`,
    [actor.ownerId, repo, transport, JSON.stringify(cfg)],
  );
  return ok(toConfig(rows[0]!));
}

/** What `dm doctor` and `dm backup status` read to say "this is stale" without
 *  having to reach the destination at all. */
export async function recordBackupRun(
  deps: Deps,
  actor: Actor,
  outcome: { ok: boolean; snapshotId?: string | null; error?: string | null },
): Promise<Result<BackupConfig>> {
  const { rows } = await deps.db.query<ConfigRow>(
    `update backup_config
        set last_run_at = now(), last_ok = $2, last_snapshot_id = $3,
            last_error = $4, updated_at = now()
      where owner_id = $1
      returning *`,
    [actor.ownerId, outcome.ok, outcome.snapshotId ?? null, outcome.error ?? null],
  );
  if (rows.length === 0) return err('not_found', 'No hay un respaldo configurado para este dueño.');
  return ok(toConfig(rows[0]!));
}

/** Separate from a run because copying and proving you can come back differ. */
export async function recordBackupVerified(deps: Deps, actor: Actor): Promise<Result<BackupConfig>> {
  const { rows } = await deps.db.query<ConfigRow>(
    `update backup_config set last_verified_at = now(), updated_at = now()
      where owner_id = $1 returning *`,
    [actor.ownerId],
  );
  if (rows.length === 0) return err('not_found', 'No hay un respaldo configurado para este dueño.');
  return ok(toConfig(rows[0]!));
}

/**
 * Where the readable copy goes, or null to stop making one.
 *
 * Refused when it is the repository itself: a restic repo and a tree of
 * documents in one folder is the kind of mistake that looks fine until a sync
 * deletes pack files.
 */
export async function setMirrorPath(
  deps: Deps,
  actor: Actor,
  path: string | null,
): Promise<Result<BackupConfig>> {
  const trimmed = path?.trim() || null;

  if (trimmed) {
    const current = await readBackupConfig(deps, actor);
    if (!current.ok) return current;
    if (!current.value) return err('not_found', 'Configura primero el destino: dm backup set <repositorio>');
    const repo = current.value.repository.replace(/\/+$/, '');
    if (trimmed.replace(/\/+$/, '') === repo) {
      return err('invalid', 'El espejo no puede ir en la misma carpeta que el repositorio: uno es un repo de restic y el otro un árbol de documentos.');
    }
  }

  const { rows } = await deps.db.query<ConfigRow>(
    `update backup_config set mirror_path = $2, updated_at = now()
      where owner_id = $1 returning *`,
    [actor.ownerId, trimmed],
  );
  if (rows.length === 0) return err('not_found', 'No hay un respaldo configurado para este dueño.');
  return ok(toConfig(rows[0]!));
}

/** Which secrets a destination needs, so a caller can say what is missing. */
export const secretsNeededBy = (c: BackupConfig): readonly string[] =>
  c.transport === 'webdav' ? ['passphrase', 'transport'] : ['passphrase'];
