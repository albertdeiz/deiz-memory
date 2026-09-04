-- Typed data.
--
-- A search orders documents by resemblance. Asking for a deductible does not
-- want an order: it wants a number. These two tables are the fact mode.

-- The registry of what to extract. Data and not an enum, for the same reason as
-- the domains: adding a type must not require a deploy.
create table fact_types (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references owners(id) on delete restrict,
  slug           text not null,
  label          text not null,
  -- The model reads this to decide whether a document is of this type. Like a
  -- domain's description, it is not documentation: it is the prompt.
  description    text not null,
  -- A state has one current version and succeeds; a period coexists. Confusing
  -- them would mark July's statement superseded by August's, which is worse than
  -- not having the datum.
  kind           text not null check (kind in ('state', 'period')),
  -- Which category to try extracting from. Without it the model would have to be
  -- called on every memory just to discover it does not apply.
  domain_slug    text,
  -- [{ name, kind, label, aliases[] }]. The kind describes the field in the prompt
  -- and validates what comes back; the aliases connect a question to a field
  -- without asking a model.
  fields         jsonb not null,
  -- Which field distinguishes two instances: the plate, the card.
  identity_field text,
  -- Which fields the validity dates come from. For a state they are the policy's
  -- validity; for a period, the billed window. They live here and are not
  -- hardcoded because the type is data, and so is its time window.
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
  -- Where it came from. Mandatory: no citation, no answer — and for that same
  -- reason it cascades: a fact without its memory means nothing.
  memory_id     uuid not null references memories(id) on delete cascade,
  type_id       uuid not null references fact_types(id) on delete restrict,
  payload       jsonb not null,
  -- Copy of the identity field, to group without opening the jsonb.
  identity      text,
  valid_from    date,
  -- What makes it possible to answer "expired" instead of answering wrong.
  valid_until   date,
  -- A new policy does not delete the old one: it supersedes it. The old one keeps
  -- answering "what did it cover last year?".
  superseded_by uuid references facts(id) on delete set null,
  confidence    real not null default 1 check (confidence >= 0 and confidence <= 1),
  extracted_at  timestamptz not null default now(),
  -- A document yields at most one fact of each type. Re-extracting replaces.
  unique (memory_id, type_id)
);

create index facts_owner_type_idx on facts (owner_id, type_id);

-- The index the fact mode uses: what is live, which is almost always what gets
-- asked. Partial because superseded rows are a minority and not queried by default.
create index facts_live_idx on facts (owner_id, type_id, identity)
  where superseded_by is null;
