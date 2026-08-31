-- F1.6: la bandeja de revisión.
--
-- §3.4 promete que si el sistema duda, guarda igual y deja la duda en una
-- bandeja. La primera mitad funcionaba desde F1 —nada bloquea la captura y el
-- problema queda anotado en la fila— pero no había dónde ver esas dudas, así
-- que revisar era escribir SQL.

-- Si reintentar puede servir de algo.
--
-- No es lo mismo un servicio que estaba apagado que un formato que ningún
-- carril sabe leer: al primero lo arregla `dm reprocess`, al segundo solo lo
-- arregla escribir código. Ofrecer el mismo botón para los dos es ofrecer un
-- botón que a veces no hace nada.
--
-- Lo decide quien falla, no una expresión regular sobre el mensaje: los
-- adapters lanzan un error marcado como permanente cuando saben que reintentar
-- no cambiaría nada (ver `PermanentError` en el core).
--
-- `null` significa "no se sabe" — es lo que queda en las filas que fallaron
-- antes de que esto existiera, y se resuelve solo la próxima vez que corran.
alter table memories add column normalization_retryable boolean;

-- `status` estaba mintiendo, y vale la pena dejar escrito por qué.
--
-- F0 marcaba `normalized` cuando `normalized_text` no era null — y en F0 ahí
-- vivía la nota que escribía la persona. La migración 003 movió esa nota a
-- `note`, y F1 después falló al leer esos archivos; como una corrida con error
-- no toca el estado, quedó el `normalized` viejo sobre memorias sin una sola
-- letra extraída.
--
-- Desde acá el estado dice la verdad: lo que necesita una mirada humana es
-- `needs_review`, que hasta hoy existía en el CHECK y no lo escribía nadie.
update memories
   set status = 'needs_review'
 where normalization_error is not null;

-- La bandeja es una consulta frecuente y casi siempre vacía: parcial.
create index memories_review_idx on memories (owner_id, captured_at desc)
  where normalization_error is not null;
