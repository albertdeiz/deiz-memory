-- Datos tipados (§4).
--
-- Una búsqueda ordena documentos por parecido. "¿Cuánto es mi deducible?" no
-- quiere un orden: quiere un número. Estas dos tablas son el modo hecho de §6.

-- El registro de qué extraer. Es data, no un enum, por la misma razón que los
-- dominios (§3.7): agregar un tipo no puede requerir un deploy.
create table fact_types (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references owners(id) on delete restrict,
  slug           text not null,
  label          text not null,
  -- La lee el modelo para decidir si el documento es de este tipo. Como la
  -- `description` de un dominio, no es documentación: es el prompt.
  description    text not null,
  -- `estado` tiene uno vigente y sucede; `periodo` coexiste. Confundirlos
  -- marcaría la cartola de julio como superada por la de agosto, que es peor
  -- que no tener el dato.
  kind           text not null check (kind in ('state', 'period')),
  -- De qué categoría intentar extraer. Sin esto habría que llamar al modelo
  -- sobre cada memoria para descubrir que no aplica.
  domain_slug    text,
  -- [{ name, kind, label, aliases[] }]. `kind` describe el campo en el prompt
  -- y valida lo que vuelve; `aliases` conecta una pregunta con un campo sin
  -- preguntarle a un modelo.
  fields         jsonb not null,
  -- Cuál de los campos distingue dos instancias: la patente, la tarjeta.
  identity_field text,
  -- De qué campos salen las fechas de vigencia. En un `estado` son la vigencia
  -- de la póliza; en un `periodo`, el período facturado. Van acá y no
  -- hardcodeados porque el tipo es data, y su ventana temporal también.
  valid_from_field  text,
  valid_until_field text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (owner_id, slug)
);

create index fact_types_owner_idx on fact_types (owner_id) where active;

create table facts (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references owners(id) on delete restrict,
  -- De dónde salió. Obligatorio: sin cita no hay respuesta (regla dura 1), y
  -- por eso mismo cascade — un hecho sin su memoria no significa nada.
  memory_id     uuid not null references memories(id) on delete cascade,
  type_id       uuid not null references fact_types(id) on delete restrict,
  payload       jsonb not null,
  -- Copia del campo identidad, para agrupar sin abrir el jsonb.
  identity      text,
  valid_from    date,
  -- Lo que hace posible responder "vencido" en vez de responder mal (§1.3).
  valid_until   date,
  -- La póliza nueva no borra a la vieja: la supera. La vieja sigue
  -- respondiendo "¿qué cubría el año pasado?".
  superseded_by uuid references facts(id) on delete set null,
  confidence    real not null default 1 check (confidence >= 0 and confidence <= 1),
  extracted_at  timestamptz not null default now(),
  -- Un documento da como mucho un hecho de cada tipo. Reextraer reemplaza.
  unique (memory_id, type_id)
);

create index facts_owner_type_idx on facts (owner_id, type_id);

-- El índice que usa el modo hecho: lo vigente, que es casi siempre lo que se
-- pregunta. Parcial porque lo superado es minoría y no se consulta por defecto.
create index facts_live_idx on facts (owner_id, type_id, identity)
  where superseded_by is null;
