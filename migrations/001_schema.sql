-- El esquema completo, en un solo archivo.
--
-- Consolidado de las siete migraciones que lo fueron construyendo mientras el
-- diseño se movía. Nada de eso es historia que valga la pena arrastrar: el
-- proyecto no ha desplegado en ninguna parte, y siete archivos donde el tercero
-- deshace al primero se leen peor que uno solo que dice cómo son las cosas.
--
-- Lo que sí se conserva es el **porqué** de cada decisión, que es lo que cuesta
-- reconstruir después.

create extension if not exists unaccent;
-- Vectores en la misma base que lo estructurado y el full-text (§8): un motor,
-- un backup, y la posibilidad de filtrar por dominio ANTES de buscar por
-- semejanza — que es lo que hace útil la búsqueda híbrida (§6).
create extension if not exists vector;

-- Búsqueda en español que además ignora tildes: en Chile la gente escribe
-- "mecanico" y tiene que encontrar "mecánico".
--
-- El costo de esto, que conviene saber: el stemmer corta hasta la raíz, y a
-- veces esa raíz la comparten palabras sin relación. Buscar "deducible" trae
-- también un poder notarial que dice "deducir una acción" —presentar una
-- demanda, en español jurídico chileno— porque las dos dan `deduc`. Se acepta:
-- es el mismo mecanismo que hace que "recetas" encuentre "recetó".
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'es_unaccent') then
    create text search configuration es_unaccent (copy = spanish);
    alter text search configuration es_unaccent
      alter mapping for hword, hword_part, word with unaccent, spanish_stem;
  end if;
end $$;

-- `array_to_string` está marcada STABLE y una columna generada exige IMMUTABLE.
-- Sobre `text[]` con separador constante lo es de verdad —no depende de locale
-- ni de configuración—, así que declararlo es correcto y no una mentira para
-- que Postgres deje pasar.
create function dm_tags_text(text[]) returns text
  language sql immutable strict parallel safe
  as $$ select array_to_string($1, ' ') $$;

create table owners (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  created_at  timestamptz not null default now()
);

-- Direccionable por contenido: el mismo archivo dos veces = un blob, dos
-- memorias. Compartir una memoria nunca mueve ni copia bytes.
create table blobs (
  sha256      text primary key,
  size_bytes  bigint not null check (size_bytes >= 0),
  media_type  text not null,
  storage_key text not null unique,
  created_at  timestamptz not null default now()
);

-- Las categorías son **filas editables, nunca un enum en el código** (§3.7):
-- agregar una no puede requerir un deploy. El prompt del clasificador se arma
-- en runtime leyendo esta tabla.
create table domains (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners(id) on delete restrict,
  -- Para comandos: /migracion
  slug        text not null,
  -- Para mostrar. Renombrable sin romper nada: la identidad es el id.
  label       text not null,
  -- Esto NO es documentación, es el prompt. Y está medido: con la descripción
  -- de "Hogar" hablando solo de garantías y gastos comunes, el manual de una
  -- alarma quedaba sin clasificar con 0,95 de confianza. Ampliarla lo arregló
  -- sin tocar código.
  description text not null,
  aliases     text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Único por dueño, no global: tus categorías son tuyas.
  unique (owner_id, slug)
);

create index domains_owner_active_idx on domains (owner_id) where active;

create table memories (
  id                uuid primary key default gen_random_uuid(),
  -- En TODA tabla desde el día uno. Meter tenencia después es una migración
  -- brutal; meterla ahora es una columna.
  owner_id          uuid not null references owners(id) on delete restrict,
  source            text not null,
  captured_at       timestamptz not null default now(),
  -- Cuándo pasó el hecho, que no es cuándo lo guardaste (§3.3). Lo infiere el
  -- clasificador; dentro de un dominio se ordena por esto.
  occurred_at       timestamptz,
  blob_sha256       text references blobs(sha256) on delete restrict,
  original_filename text,
  title             text,

  -- La línea que separa lo tuyo de lo derivado, y que hay que respetar:
  --
  --   note             lo que escribiste tú. Nunca se regenera, nunca se pisa.
  --   normalized_text  lo que se extrajo del blob. Regenerable siempre.
  --
  -- En F0 vivían en la misma columna, y la primera transcripción de una foto
  -- se comía la nota que le habías puesto al mandarla. Es lo que hace posible
  -- reprocesar sin miedo: todo lo derivado está de un lado, y el otro lado no
  -- se toca jamás.
  note              text,
  normalized_text   text,

  -- Cómo se leyó el archivo, para poder reprocesar sin adivinar (§8.1).
  --   text · document · vision · audio · none
  normalization_lane text,
  normalized_at      timestamptz,
  normalization_error text,
  normalization_detail jsonb,
  -- Si reintentar puede servir de algo. Un servicio caído se arregla con
  -- `dm reprocess`; un formato que ningún carril sabe leer, no. Ofrecer el
  -- mismo botón para los dos enseña a desconfiar del botón. Lo declara quien
  -- falla, no una expresión regular sobre el mensaje.
  normalization_retryable boolean,

  -- Un dominio primario mantiene /migracion limpio y el clasificador simple;
  -- lo que cruza categorías va en tags (§9).
  domain_id         uuid references domains(id) on delete set null,
  tags              text[] not null default '{}',
  domain_confidence real,

  status            text not null default 'raw',
  hidden            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Los pesos importan. El título y las etiquetas son lo que la persona
  -- escribió para encontrar algo, así que van en A. El nombre del archivo casi
  -- nunca significa nada —IMG_20260114.jpg, scan0001.pdf— pero se indexa igual
  -- en D, por si acaso lo recuerdas: nunca le gana a una coincidencia real.
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

-- Los dos índices parciales del día a día. Parciales porque lo normal es que
-- estas dos listas estén vacías: qué falta leer, y qué quedó dudoso.
create index memories_pending_idx on memories (owner_id, captured_at)
  where blob_sha256 is not null and normalized_at is null;
create index memories_review_idx on memories (owner_id, captured_at desc)
  where normalization_error is not null;

-- La identidad es el user id del canal (§10). No hay cuentas ni contraseñas:
-- tu mamá abre un link y está adentro.
--
-- Y de acá sale algo que vale más que la tabla: toda operación del core exige
-- un Actor, y el Actor sale de acá. Sin vínculo no hay Actor, y sin Actor no
-- existe el camino para llamar a nada. La regla dura 9 deja de depender de que
-- alguien se acuerde de escribir el WHERE.
create table channel_identities (
  channel          text not null,
  external_user_id text not null,
  owner_id         uuid not null references owners(id) on delete restrict,
  display_name     text,
  linked_at        timestamptz not null default now(),
  last_seen_at     timestamptz,
  primary key (channel, external_user_id)
);

-- Sin unique en owner_id: la misma persona puede tener Telegram y WhatsApp.
create index channel_identities_owner_idx on channel_identities (owner_id);

-- El emparejamiento: un código de un solo uso y con vencimiento. Es el mismo
-- mecanismo que F5 va a necesitar para `/invitar casa`.
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

-- El estado de una conversación. Vive acá y NO dentro del payload del botón, y
-- esa decisión es la que permite degradar a un canal sin botones: con el estado
-- en la base, el botón "más" y la palabra "más" valen los mismos tres bytes.
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

-- Los trozos en que se parte una memoria para buscarla por semejanza.
--
-- Por trozo y no por memoria entera: una póliza de 80 mil caracteres da un solo
-- vector promediado que no se parece a nada en particular, y la pregunta
-- "¿cuál es mi deducible?" necesita acertarle al párrafo del deducible, no al
-- documento completo.
--
-- Es tabla aparte y no una columna porque una memoria tiene N trozos, y porque
-- así el embedding se regenera solo —igual que el texto— sin tocar la memoria.
create table memory_chunks (
  id         bigserial primary key,
  memory_id  uuid not null references memories(id) on delete cascade,
  owner_id   uuid not null references owners(id) on delete restrict,
  -- Posición dentro del documento, para poder citar "hacia el final de".
  seq        integer not null,
  content    text not null,
  -- 768 es lo que produce nomic-embed-text. Cambiar de modelo cambia esta
  -- dimensión, así que cambiar de modelo es reindexar — no es gratis y conviene
  -- que esté escrito acá.
  embedding  vector(768),
  created_at timestamptz not null default now(),
  unique (memory_id, seq)
);

-- El índice va sobre el vector, pero la consulta filtra primero por dueño y
-- dominio: buscar por semejanza en todo el corpus y después descartar es
-- justamente lo que §6 llama el error clásico.
create index memory_chunks_owner_idx on memory_chunks (owner_id, memory_id);
create index memory_chunks_vec_idx on memory_chunks
  using hnsw (embedding vector_cosine_ops);

-- Lo escribe purge (regla dura 8). Append-only de verdad: purgar es la única
-- forma de borrar, y queda registrada.
create table audit_log (
  id         bigserial primary key,
  owner_id   uuid not null references owners(id) on delete restrict,
  action     text not null,
  subject_id uuid,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

create index audit_log_owner_at_idx on audit_log (owner_id, at desc);
