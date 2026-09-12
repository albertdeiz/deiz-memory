-- The backup, per owner.
--
-- A backup is not of "the system": it is of a person. Putting two owners in one
-- snapshot would hand each of them the other's data at restore time, which is
-- exactly what hard rule 9 exists to prevent — and a restore is not a place to
-- discover the rule only covered queries.
--
-- So the destination is a row per owner, and it is data: `dm backup status` reads
-- it and `dm backup set` writes it. What is NOT here is the passphrase. Storing it next to what it
-- protects is the ceremony §14.2 rejects, so it is resolved per owner from the
-- environment and this system never writes it down.
create table backup_config (
  owner_id     uuid primary key references owners(id) on delete restrict,
  -- A restic repository, as restic spells it: `rclone:nc:deiz-memory/<owner>`,
  -- `b2:bucket:path`, a local path.
  repository   text not null,
  -- How to reach it, when restic cannot on its own. `none` covers every backend
  -- restic speaks natively — B2, S3, R2, a local path; `webdav` builds an rclone
  -- remote. No check constraint on purpose: the set of transports is whatever
  -- the code knows how to configure, so the compiler is the honest place to
  -- enforce it, and adding one should not need a migration.
  transport    text not null default 'none',
  -- The non-secret half of reaching the destination: a URL, a username, a
  -- vendor. jsonb and not columns, for the same reason a domain is a row and not
  -- an enum (§3.7) — a `webdav_url` column would be dead weight the day the
  -- destination is B2, and adding B2's fields would be a migration.
  --
  -- Nothing secret goes in here. The credential and the passphrase are resolved
  -- per owner from the environment (§14.3).
  transport_config jsonb not null default '{}'::jsonb,
  -- What tells you the backup is stale, and what `dm doctor` reports. Nullable
  -- because a configured destination that never ran is a real state, and the
  -- honest thing is to show it as such rather than as a failure.
  last_run_at  timestamptz,
  last_snapshot_id text,
  -- Split from last_run_at on purpose: "ran and failed" and "never ran" are
  -- different problems and only one of them is urgent.
  last_ok      boolean,
  last_error   text,
  -- Where the readable copy goes, and null means "do not make one". A separate
  -- destination from `repository` on purpose and never the same folder: one is
  -- an opaque restic repo and the other a tree of documents, and putting them
  -- together is a mess that only looks like it works.
  mirror_path  text,
  -- The last verified restore, which is the only thing that makes a backup real
  -- (§14.3). Separate from last_run_at because copying and proving you can come
  -- back are different claims, and the second one is the one that matters.
  last_verified_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
