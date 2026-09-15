-- How many facts of a type one document carries (§4).
--
-- A second axis, not a flavour of `kind`. `kind` answers whether a new one
-- supersedes the old; this answers how many a single document holds, and the two
-- are independent: a bus ticket is `periodo` (September's does not replace
-- August's) AND `many` (one PDF carries two passengers).
alter table fact_types
  add column cardinality text not null default 'one'
    check (cardinality in ('one', 'many'));

-- The constraint that made the second passenger overwrite the first.
--
-- `identity` already meant "the field that distinguishes two instances"; the only
-- thing tying it to separate documents was this key. With identity in it, two
-- rows from one PDF coexist — and supersession needs no change, because it was
-- already keyed on identity rather than on the document.
--
-- `identity` is nullable and Postgres treats NULLs as distinct in a unique
-- index, which would let a `one` type accumulate duplicate rows. `coalesce` to a
-- constant keeps "no identity" meaning exactly one row, which is what a `one`
-- type is.
alter table facts drop constraint facts_memory_id_type_id_key;
create unique index facts_memory_type_identity_key
  on facts (memory_id, type_id, coalesce(identity, ''));
