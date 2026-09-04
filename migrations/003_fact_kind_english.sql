-- Fact kinds in English, like the rest of the semantics.
--
-- The values are part of the code's vocabulary, not content: a domain slug is
-- the owner's word, but `state` vs `period` is a branch in the extractor.
alter table fact_types drop constraint fact_types_kind_check;

update fact_types set kind = case kind
  when 'estado'  then 'state'
  when 'periodo' then 'period'
  else kind
end;

alter table fact_types add constraint fact_types_kind_check
  check (kind in ('state', 'period'));
