-- F1.5: el canal de chat.
--
-- Tres tablas, y ninguna guarda mensajes. Lo que se conversa no es una memoria:
-- lo que se guarda entra por capture() como cualquier otra cosa, y el resto
-- —quién eres, en qué página vas— es estado de la conversación y nada más.

-- La identidad es el user id del canal (§10). No hay cuentas, no hay
-- contraseñas, no hay verificación de correo: tu mamá abre un link y está
-- adentro. Lo que sí hay es un vínculo explícito entre esa identidad y un dueño.
--
-- Y de acá sale una propiedad que vale más que la tabla: toda operación del core
-- exige un `Actor`, y el Actor sale de acá. Sin vínculo no hay Actor, y sin
-- Actor no hay forma de llamar a nada. La regla dura 9 deja de depender de que
-- alguien se acuerde de escribir el WHERE — no existe el camino.
create table channel_identities (
  channel          text not null,
  external_user_id text not null,
  owner_id         uuid not null references owners(id) on delete restrict,
  display_name     text,
  linked_at        timestamptz not null default now(),
  last_seen_at     timestamptz,
  primary key (channel, external_user_id)
);

-- Sin unique en owner_id, a propósito: la misma persona puede tener Telegram y
-- WhatsApp, y las dos identidades apuntan al mismo dueño.
create index channel_identities_owner_idx on channel_identities (owner_id);

-- El emparejamiento: un código de un solo uso y con vencimiento.
--
-- Es tabla y no una variable de entorno por dos razones. La primera es de uso:
-- un id de Telegram escrito a mano en un .env es el error del enum aplicado a
-- la identidad. La segunda es que este es exactamente el mecanismo que F5 va a
-- necesitar para `/invitar casa` — ahí gana una columna `space_id` y el
-- `owner_id` se vuelve nullable, que es una migración de dos líneas. Adivinar
-- hoy esa forma sí sería caro.
create table pairing_codes (
  code       text primary key,
  owner_id   uuid not null references owners(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    text,
  constraint pairing_codes_window_chk check (expires_at > created_at)
);

create index pairing_codes_open_idx on pairing_codes (owner_id)
  where used_at is null;

-- El estado de una conversación: qué buscaste al final y qué está esperando un
-- sí. Vive en la base y NO dentro del payload del botón, y esa es justo la
-- decisión que hace posible degradar a un canal sin botones.
--
-- Si el cursor viajara en el `callback_data`, un canal sin botones no podría
-- reproducirlo: nadie va a tipear un token de 64 bytes. Con el estado acá, el
-- botón "más" y la palabra "más" valen los mismos tres bytes.
create table chat_sessions (
  channel     text not null,
  chat_id     text not null,
  owner_id    uuid not null references owners(id) on delete restrict,
  last_query  text,
  last_offset integer not null default 0 check (last_offset >= 0),
  -- { ids: [...] } de la última página, o { confirm: {...}, askedAt } en curso.
  pending     jsonb,
  updated_at  timestamptz not null default now(),
  primary key (channel, chat_id)
);
