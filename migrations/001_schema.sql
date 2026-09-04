-- The complete schema, in a single file.
--
-- Consolidated from the migrations that built it while the design moved. None of
-- that is history worth dragging along: the project had not deployed anywhere,
-- and seven files where the third undoes the first read worse than one that says
-- how things are.
--
-- What is kept is the **why** of each decision, which is the expensive thing to
-- reconstruct later.

create extension if not exists unaccent;
-- Vectors in the same database as the structured data and full text: one engine,
-- one backup, and the ability to filter by domain BEFORE searching by similarity
-- — which is what makes hybrid search useful.
create extension if not exists vector;

-- Spanish search that also ignores accents: people type without them and still
-- have to find the accented word.
--
-- The cost, worth knowing: the stemmer cuts to the root, and sometimes unrelated
-- words share that root, so a search occasionally brings a distant cousin. It is
-- accepted: it is the same mechanism that makes a plural find its singular and a
-- noun find its verb.
--
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'es_unaccent') then
    create text search configuration es_unaccent (copy = spanish);
    alter text search configuration es_unaccent
      alter mapping for hword, hword_part, word with unaccent, spanish_stem;
  end if;
end $$;

-- The array-joining function is marked STABLE and a generated column demands
-- IMMUTABLE. Over a text array with a constant separator it genuinely is — it
-- depends on neither locale nor configuration — so declaring it is correct and
-- not a lie to get past the checker.
create function dm_tags_text(text[]) returns text
  language sql immutable strict parallel safe
  as $$ select array_to_string($1, ' ') $$;

create table owners (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  created_at  timestamptz not null default now()
);

-- Content addressed: the same file twice is one blob and two memories. Sharing a
-- memory never moves or copies bytes.
create table blobs (
  sha256      text primary key,
  size_bytes  bigint not null check (size_bytes >= 0),
  media_type  text not null,
  storage_key text not null unique,
  created_at  timestamptz not null default now()
);

-- Categories are **editable rows, never an enum in the code**: adding one must
-- not require a deploy. The classifier's prompt is assembled at runtime by
-- reading this table.
create table domains (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners(id) on delete restrict,
  -- For commands: /category-slug
  slug        text not null,
  -- For display. Renamable without breaking anything: the identity is the id.
  label       text not null,
  -- This is NOT documentation, it is the prompt. And it is measured: with one
  -- category's description covering only part of its scope, a document went
  -- unclassified with 0.95 confidence. Widening the description fixed it with no
  -- code change.
  description text not null,
  aliases     text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Unique per owner, not global: your categories are yours.
  unique (owner_id, slug)
);

create index domains_owner_active_idx on domains (owner_id) where active;

create table memories (
  id                uuid primary key default gen_random_uuid(),
  -- In EVERY table from day one. Retrofitting tenancy is a brutal migration;
  -- adding it now is a column.
  owner_id          uuid not null references owners(id) on delete restrict,
  source            text not null,
  captured_at       timestamptz not null default now(),
  -- When the event happened, which is not when you stored it. The classifier
  -- infers it; inside a domain this is the sort key.
  occurred_at       timestamptz,
  blob_sha256       text references blobs(sha256) on delete restrict,
  original_filename text,
  title             text,

  -- The line separating yours from derived, which has to be respected:
  --
  -- note             what you wrote. Never regenerated, never overwritten.
  -- normalized_text  what was read from the blob. Always regenerable.
  --
  -- They used to live in one column, and the first transcript of a photo ate the
  -- note you attached when sending it. This split is what makes reprocessing safe:
  -- everything derived is on one side, and the other side is never touched.
  --
  note              text,
  normalized_text   text,

  -- How the file was read, so a reprocess does not have to guess.
  --   text · document · vision · audio · none
  normalization_lane text,
  normalized_at      timestamptz,
  normalization_error text,
  normalization_detail jsonb,
  -- Whether retrying can help at all. A service being down is fixed by a reprocess;
  -- a format no lane can read is not. Offering the same button for both teaches
  -- distrust of the button. Declared by whatever failed, not by a regex over the
  -- message.
  normalization_retryable boolean,

  -- One primary domain keeps each category listing clean and the classifier simple;
  -- what crosses categories goes in tags.
  domain_id         uuid references domains(id) on delete set null,
  tags              text[] not null default '{}',
  domain_confidence real,

  status            text not null default 'raw',
  hidden            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- The weights matter. Title and tags are what the person wrote in order to find
  -- something, so they go in the top band. A filename almost never means anything
  -- but is indexed in the lowest band just in case you remember it: it never beats
  -- a real match.
  search_tsv        tsvector generated always as (
    setweight(to_tsvector('es_unaccent'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('es_unaccent'::regconfig, dm_tags_text(tags)), 'A') ||
    setweight(to_tsvector('es_unaccent'::regconfig, coalesce(normalized_text, '')), 'B') ||
    setweight(to_tsvector('es_unaccent'::regconfig, coalesce(note, '')), 'B') ||
    setweight(
      to_tsvector('es_unaccent'::regconfig,
        translate(coalesce(original_filename, ''), '._-', '   ')), 'D')
  ) stored,

  constraint memories_source_chk  check (source in ('cli', 'telegram', 'manual')),
  constraint memories_status_chk  check (status in ('raw', 'normalized', 'classified', 'needs_review', 'verified')),
  constraint memories_lane_chk    check (normalization_lane is null
      or normalization_lane in ('text', 'document', 'vision', 'audio', 'none')),
  constraint memories_confidence_chk check (domain_confidence is null
      or (domain_confidence >= 0 and domain_confidence <= 1)),
  constraint memories_content_chk check (blob_sha256 is not null
      or normalized_text is not null or note is not null)
);

create index memories_owner_captured_idx on memories (owner_id, captured_at desc);
create index memories_search_idx         on memories using gin (search_tsv);
create index memories_tags_idx           on memories using gin (tags);
create index memories_blob_idx           on memories (blob_sha256);
create index memories_domain_idx         on memories (owner_id, domain_id, occurred_at desc nulls last);

-- The two day-to-day partial indexes. Partial because the normal state of both
-- lists is empty: what is unread, and what came out doubtful.
create index memories_pending_idx on memories (owner_id, captured_at)
  where blob_sha256 is not null and normalized_at is null;
create index memories_review_idx on memories (owner_id, captured_at desc)
  where normalization_error is not null;

-- The identity is the channel's own user id. No accounts and no passwords:
-- someone opens a link and is inside.
--
-- And from here comes something worth more than the table: every core operation
-- demands an actor, and the actor comes from here. No link, no actor; no actor,
-- no path to call anything. Owner isolation stops depending on someone
-- remembering to write the WHERE.
create table channel_identities (
  channel          text not null,
  external_user_id text not null,
  owner_id         uuid not null references owners(id) on delete restrict,
  display_name     text,
  linked_at        timestamptz not null default now(),
  last_seen_at     timestamptz,
  primary key (channel, external_user_id)
);

-- No unique on owner_id: the same person can have two channels.
create index channel_identities_owner_idx on channel_identities (owner_id);

-- Pairing: a single-use code with an expiry. The same mechanism a shared-space
-- invitation would need.
create table pairing_codes (
  code       text primary key,
  owner_id   uuid not null references owners(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    text,
  constraint pairing_codes_window_chk check (expires_at > created_at)
);

create index pairing_codes_open_idx on pairing_codes (owner_id) where used_at is null;

-- The state of a conversation. It lives here and NOT inside the button payload,
-- and that decision is what allows degrading to a channel without buttons: with
-- the state in the database, the button and the typed word cost the same.
create table chat_sessions (
  channel     text not null,
  chat_id     text not null,
  owner_id    uuid not null references owners(id) on delete restrict,
  last_query  text,
  last_offset integer not null default 0 check (last_offset >= 0),
  pending     jsonb,
  updated_at  timestamptz not null default now(),
  primary key (channel, chat_id)
);

-- The chunks a memory is split into so it can be found by similarity.
--
-- Per chunk and not per whole memory: a policy of eighty thousand characters
-- yields one averaged vector resembling nothing in particular, and a question
-- about a deductible needs to hit the deductible paragraph, not the whole
-- document.
--
-- A separate table and not a column because a memory has N chunks, and because
-- this way the embedding regenerates on its own, like the text, untouched memory.
create table memory_chunks (
  id         bigserial primary key,
  memory_id  uuid not null references memories(id) on delete cascade,
  owner_id   uuid not null references owners(id) on delete restrict,
  -- Position within the document, so a citation can say "near the end of".
  seq        integer not null,
  content    text not null,
  -- This width is what the embedding model produces. Changing model changes it, so
  -- changing model means reindexing — not free, and worth having written here.
  --
  embedding  vector(768),
  created_at timestamptz not null default now(),
  unique (memory_id, seq)
);

-- The index is on the vector, but the query filters by owner and domain first:
-- searching the whole corpus by similarity and discarding afterwards is exactly
-- the classic mistake.
create index memory_chunks_owner_idx on memory_chunks (owner_id, memory_id);
create index memory_chunks_vec_idx on memory_chunks
  using hnsw (embedding vector_cosine_ops);

-- Written by purge. Genuinely append-only: purging is the only way to delete,
-- and it is recorded.
create table audit_log (
  id         bigserial primary key,
  owner_id   uuid not null references owners(id) on delete restrict,
  action     text not null,
  subject_id uuid,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

create index audit_log_owner_at_idx on audit_log (owner_id, at desc);
