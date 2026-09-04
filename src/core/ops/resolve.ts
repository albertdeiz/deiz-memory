import type { Actor, Uuid } from '../domain/types';
import type { Db } from '../ports';
import { err, ok, type Result } from '../result';

const REF = /^[0-9a-f-]{4,36}$/i;

/**
 * Resolves an id prefix, git style. Accepts it with or without dashes.
 *
 * Always filtered by owner, and someone else's prefix is not_found rather than
 * forbidden — saying "it exists but is not yours" already leaks information.
 */
export async function resolveMemoryId(
  db: Db,
  actor: Actor,
  ref: string,
): Promise<Result<Uuid>> {
  const clean = ref.trim();
  if (!REF.test(clean)) {
    return err('invalid', `"${ref}" no parece un id ni un prefijo de id.`);
  }
  const { rows } = await db.query<{ id: string }>(
    `select id from memories
      where owner_id = $1
        and replace(id::text, '-', '') like replace(lower($2), '-', '') || '%'
      limit 3`,
    [actor.ownerId, clean],
  );
  if (rows.length === 0) return err('not_found', `No hay ninguna memoria que empiece con "${ref}".`);
  if (rows.length > 1) {
    return err('ambiguous', `"${ref}" coincide con más de una memoria. Usa más caracteres.`, {
      matches: rows.map((r) => r.id),
    });
  }
  return ok(rows[0]!.id);
}
