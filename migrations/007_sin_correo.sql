-- Se saca el correo del diseño.
--
-- §11 lo planteaba como segunda vía de captura, con buzón secreto, allowlist y
-- cuarentena. Era una respuesta razonable a un problema real —muchas cosas que
-- vale la pena guardar ya llegan por correo— pero traía consigo la superficie
-- más incómoda del sistema: un canal **no autenticado**, con remitente
-- falsificable, y toda la maquinaria de cuarentena que eso obliga a construir.
--
-- Con el chat andando, esa vía deja de ser necesaria para empezar. Se simplifica
-- ahora, y si algún día vuelve, vuelve con su propia migración.
--
-- Nada que borrar: cero memorias usan este origen.
alter table memories drop constraint memories_source_chk;
alter table memories add  constraint memories_source_chk
  check (source in ('cli', 'telegram', 'manual'));

-- `parent_id` existía solo para colgar los adjuntos de un correo del mensaje
-- que los trajo. Sin correo no tiene usuario, y una columna sin usuario es una
-- pregunta abierta para quien lea el esquema en un año.
alter table memories drop column parent_id;
