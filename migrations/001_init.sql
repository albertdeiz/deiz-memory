-- F0: captura y búsqueda full-text. Sin categorías, sin espacios.
-- owner_id va en todas las tablas desde ya: meter tenencia después es una migración
-- brutal, meterla ahora es una columna.

create extension if not exists unaccent;

-- Config de búsqueda en español que además ignora tildes: en Chile la gente escribe
-- "mecanico" y tiene que encontrar "mecánico".
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'es_unaccent') then
    create text search configuration es_unaccent (copy = spanish);
    alter text search configuration es_unaccent
      alter mapping for hword, hword_part, word with unaccent, spanish_stem;
  end if;
end $$;

create table owners (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  created_at  timestamptz not null default now()
);

-- Direccionable por contenido: el mismo archivo dos veces = un blob, dos memorias.
create table blobs (
  sha256      text primary key,
  size_bytes  bigint not null check (size_bytes >= 0),
  media_type  text not null,
  storage_key text not null unique,
  created_at  timestamptz not null default now()
);

create table memories (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references owners(id) on delete restrict,
  parent_id         uuid references memories(id) on delete set null,
  source            text not null,
  captured_at       timestamptz not null default now(),
  occurred_at       timestamptz,
  blob_sha256       text references blobs(sha256) on delete restrict,
  original_filename text,
  title             text,
  normalized_text   text,
  status            text not null default 'raw',
  hidden            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search_tsv        tsvector generated always as (
    to_tsvector('es_unaccent'::regconfig,
      coalesce(title, '') || ' ' ||
      coalesce(normalized_text, '') || ' ' ||
      -- El parser trata "poliza.pdf" como un token de archivo entero, así que
      -- buscar "poliza" no lo encontraría. Separado en partes, sí.
      translate(coalesce(original_filename, ''), '._-', '   '))
  ) stored,
  constraint memories_source_chk  check (source in ('cli', 'telegram', 'email', 'manual')),
  constraint memories_status_chk  check (status in ('raw', 'normalized', 'classified', 'needs_review', 'verified')),
  constraint memories_content_chk check (blob_sha256 is not null or normalized_text is not null)
);

create index memories_owner_captured_idx on memories (owner_id, captured_at desc);
create index memories_search_idx         on memories using gin (search_tsv);
create index memories_blob_idx           on memories (blob_sha256);

-- Lo escribe purge (regla dura 8). Append-only de verdad.
create table audit_log (
  id         bigserial primary key,
  owner_id   uuid not null references owners(id) on delete restrict,
  action     text not null,
  subject_id uuid,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

create index audit_log_owner_at_idx on audit_log (owner_id, at desc);
