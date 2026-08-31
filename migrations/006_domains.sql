-- F2: los dominios.
--
-- §3.7 es tajante: "los dominios son filas editables, nunca un enum en el
-- código. Agregar uno no puede requerir un deploy". Así que esto es una tabla,
-- y el prompt del clasificador se arma leyéndola en runtime.

create table domains (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners(id) on delete restrict,
  -- Para comandos: /migracion
  slug        text not null,
  -- Para mostrar. Renombrable sin romper nada, porque la identidad es el id.
  label       text not null,
  -- Esto NO es documentación: es el prompt (§9). El clasificador concatena las
  -- descripciones de los dominios activos, así que una descripción vaga
  -- clasifica mal. Es el único campo que de verdad mueve la precisión.
  description text not null,
  aliases     text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- El slug es único por dueño, no global: tus categorías son tuyas.
  unique (owner_id, slug)
);

create index domains_owner_active_idx on domains (owner_id) where active;

-- El dominio primario vive en la memoria; lo que cruza dominios va en tags.
-- Un solo primario mantiene /migracion limpio y el clasificador simple (§9).
alter table memories add column domain_id uuid references domains(id) on delete set null;
alter table memories add column tags text[] not null default '{}';
-- Qué tan segura fue la clasificación. Alimenta la bandeja de F1.6: por debajo
-- de cierto umbral, se guarda igual pero se marca para revisar (§3.4).
alter table memories add column domain_confidence real
  check (domain_confidence is null or (domain_confidence >= 0 and domain_confidence <= 1));

create index memories_domain_idx on memories (owner_id, domain_id, occurred_at desc nulls last);
create index memories_tags_idx on memories using gin (tags);

-- Las etiquetas también se buscan: son lo que la persona escribió para
-- encontrar algo, igual que la nota.
--
-- Hace falta este envoltorio porque `array_to_string` está marcada STABLE y una
-- columna generada exige IMMUTABLE. Sobre `text[]` con un separador constante
-- lo es de verdad —no depende de locale ni de configuración—, así que
-- declararlo es correcto y no una mentira para que Postgres deje pasar.
create function dm_tags_text(text[]) returns text
  language sql immutable strict parallel safe
  as $$ select array_to_string($1, ' ') $$;

alter table memories drop column search_tsv;

alter table memories add column search_tsv tsvector generated always as (
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(title, '')), 'A') ||
  setweight(to_tsvector('es_unaccent'::regconfig, dm_tags_text(tags)), 'A') ||
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(normalized_text, '')), 'B') ||
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(note, '')), 'B') ||
  setweight(
    to_tsvector('es_unaccent'::regconfig,
      translate(coalesce(original_filename, ''), '._-', '   ')), 'D')
) stored;

create index memories_search_idx on memories using gin (search_tsv);

-- La semilla de §9, en contexto Chile. Es semilla y no lista cerrada: se
-- renombra, se archiva y se fusiona desde el chat sin tocar el repo.
--
-- Se siembra para cada dueño que ya exista. Los que nazcan después los reciben
-- al crearse (ver `seedDomains` en el core).
insert into domains (owner_id, slug, label, description)
select o.id, d.slug, d.label, d.description
  from owners o
 cross join (values
   ('salud', 'Salud',
    'Consultas médicas, recetas, exámenes, medicamentos, alergias, vacunas, Isapre o Fonasa, bonos y reembolsos'),
   ('seguros', 'Seguros',
    'Pólizas de salud complementario, auto, hogar y vida: coberturas, deducibles, teléfonos de asistencia, número de póliza'),
   ('vehiculo', 'Vehículo',
    'Patente, revisión técnica, permiso de circulación, SOAP, mantenciones y reparaciones del auto'),
   ('documentos', 'Documentos',
    'Cédula de identidad, pasaporte, licencia de conducir, certificados civiles y de antecedentes'),
   ('finanzas', 'Finanzas',
    'Suscripciones, pagos recurrentes, garantías de compras, boletas, comprobantes y estados de cuenta'),
   ('trabajo', 'Trabajo',
    'Contratos, decisiones, contactos y compromisos laborales'),
   ('hogar', 'Hogar',
    'Garantías de electrodomésticos, técnicos de confianza, medidas, contratos de arriendo y gastos comunes'),
   ('personas', 'Personas',
    'Cumpleaños, tallas, preferencias, contactos de emergencia y datos de gente cercana')
 ) as d(slug, label, description);
