-- F1: los tres carriles de §8.1. Lo que cambia de fondo no es agregar columnas,
-- es partir en dos lo que F0 tenía junto.
--
-- F0 guardaba en normalized_text tanto lo que escribiste tú (--text) como lo que
-- venía dentro de un archivo de texto. Con los carriles eso deja de funcionar: la
-- primera transcripción de una foto pisaría tu nota, y sería irrecuperable.
--
-- Desde acá:
--   note             lo que escribió la persona. Nunca se regenera, nunca se pisa.
--   normalized_text  lo que se extrajo del blob. Regenerable siempre (UC-15).
--
-- Esa es justo la línea que hace posible reprocesar sin miedo: todo lo derivado
-- vive en un lado, y el otro lado no se toca jamás.

alter table memories add column note text;

alter table memories add column normalization_lane   text;
alter table memories add column normalized_at        timestamptz;
alter table memories add column normalization_error  text;
alter table memories add column normalization_detail jsonb;

-- text     el blob ya venía legible: se lee, no se convierte
-- document carril A · markitdown
-- vision   carril B · LLM multimodal
-- audio    carril C · whisper
-- none     no hay nada que extraer (memoria de solo nota, o formato sin carril)
alter table memories add constraint memories_lane_chk
  check (normalization_lane is null
      or normalization_lane in ('text', 'document', 'vision', 'audio', 'none'));

-- El check viejo se suelta ANTES de mover nada. El backfill de abajo deja
-- normalized_text en null para las memorias de solo texto, y el check original
-- —blob o normalized_text— las rechazaría a mitad de la propia migración.
alter table memories drop constraint memories_content_chk;

-- Backfill. Todo lo que F0 dejó en normalized_text se preserva como nota, sin
-- excepciones, y el motivo es que dejar una sola fila fuera es irreversible.
--
-- Mirando lo que F0 realmente hacía:
--
--   const body = [fromFile, text].join('\n\n')
--
-- `fromFile` solo se llenaba con blobs `text/*`. Para una foto, un PDF o un
-- docx era SIEMPRE null — o sea que en esas memorias normalized_text no es
-- texto derivado: es, palabra por palabra, la nota que escribió la persona.
-- Dejarlas fuera de este backfill significaría que la primera normalización
-- las sobreescribe con el OCR y la nota desaparece para siempre. Es justo la
-- pérdida que esta migración existe para evitar, y aplicada al histórico entero.
--
-- El único caso ambiguo es un blob `text/*` capturado CON nota: ahí F0 sí
-- concatenó las dos cosas y en SQL no hay forma de separarlas. Se preserva el
-- valor completo igual. El costo es que, después del reproceso, el contenido de
-- ese archivo va a aparecer en los dos campos; el beneficio es que la nota no se
-- pierde. Duplicar es feo y se ve; perder es definitivo y no se ve.
update memories
   set note = normalized_text, normalized_text = null
 where normalized_text is not null;

alter table memories add constraint memories_content_chk
  check (blob_sha256 is not null or normalized_text is not null or note is not null);

-- La nota pesa igual que el contenido extraído: las dos son cosas que la persona
-- de verdad busca. Solo el nombre del archivo sigue en el fondo (peso D, ver 002).
alter table memories drop column search_tsv;

alter table memories add column search_tsv tsvector generated always as (
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(title, '')), 'A') ||
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(normalized_text, '')), 'B') ||
  setweight(to_tsvector('es_unaccent'::regconfig, coalesce(note, '')), 'B') ||
  setweight(
    to_tsvector('es_unaccent'::regconfig,
      translate(coalesce(original_filename, ''), '._-', '   ')), 'D')
) stored;

create index memories_search_idx on memories using gin (search_tsv);

-- Para "qué falta normalizar" y "qué falló": las dos preguntas que hace el worker
-- y las dos que hace dm reprocess. Parcial, porque lo normal es que no haya nada.
create index memories_pending_idx on memories (owner_id, captured_at)
  where blob_sha256 is not null and normalized_at is null;

create index memories_failed_idx on memories (owner_id, captured_at)
  where normalization_error is not null;
