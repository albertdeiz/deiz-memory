-- Web sessions (§15).
--
-- The chat never needed this table, and that is the whole point. Telegram's user
-- id is unforgeable because Telegram asserts it; a cookie is asserted by this
-- system, so three things appear that §10 never had to carry: a secret, an
-- expiry and a way to revoke.
create table web_sessions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners(id) on delete restrict,
  -- The sha256 of the token, never the token: a stolen database should not be a
  -- stolen set of live sessions. (The table itself stays out of the backup — a
  -- restore must leave you logged out, not hand back old sessions — but hashing
  -- does not depend on that.)
  token_hash  text not null unique,
  -- Which pairing code opened it, so a session can be traced to the moment it
  -- was granted without keeping the code itself.
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  -- Revocation is a timestamp and not a delete: knowing a session was cut, and
  -- when, is the kind of thing you want the day you wonder why.
  revoked_at  timestamptz,
  last_seen_at timestamptz,
  user_agent  text
);

create index web_sessions_owner_idx on web_sessions (owner_id)
  where revoked_at is null;

-- Expired rows are not interesting and there are many of them; this is what
-- makes cleaning them cheap.
create index web_sessions_expiry_idx on web_sessions (expires_at)
  where revoked_at is null;
