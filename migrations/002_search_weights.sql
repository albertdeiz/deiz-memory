-- El nombre del archivo casi nunca significa algo: IMG_20260114_093312.jpg,
-- WhatsApp Image 2026-01-14 at 09.33.12.jpeg, scan0001.pdf, documento (3).pdf.
-- Sigue indexado —a veces sí recuerdas el nombre— pero con el peso más bajo,
-- para que jamás le gane a una coincidencia en el contenido real.
alter table memories drop column search_tsv;

alter table memories add column search_tsv tsvector generated always as (
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(title, '')), 'A') ||
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(normalized_text, '')), 'B') ||
  setweight(
    to_tsvector('es_unaccent'::regconfig,
      translate(coalesce(original_filename, ''), '._-', '   ')), 'D')
) stored;

create index memories_search_idx on memories using gin (search_tsv);
