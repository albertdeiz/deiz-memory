import type { Owner, Uuid } from '../domain/types.js';
import type { Db } from '../ports.js';
import { err, ok, type Result } from '../result.js';
import { seedDomains } from './domains.js';

const toOwner = (r: { id: string; label: string; created_at: Date }): Owner => ({
  id: r.id,
  label: r.label,
  createdAt: r.created_at,
});

export async function listOwners(db: Db): Promise<Owner[]> {
  const { rows } = await db.query<{ id: string; label: string; created_at: Date }>(
    `select id, label, created_at from owners order by created_at asc`,
  );
  return rows.map(toOwner);
}

export async function createOwner(db: Db, label: string): Promise<Result<Owner>> {
  const clean = label.trim();
  if (!clean) return err('invalid', 'El dueño necesita un nombre.');
  const { rows } = await db.query<{ id: string; label: string; created_at: Date }>(
    `insert into owners (label) values ($1) returning id, label, created_at`,
    [clean],
  );
  const owner = toOwner(rows[0]!);
  // Nace con las categorías de §9. Sin esto el clasificador no tendría contra
  // qué clasificar, y la primera experiencia sería una lista vacía.
  await seedDomains(db, owner.id);
  return ok(owner);
}

/**
 * En un sistema de un dueño no tiene sentido escribir --actor en cada comando.
 * Si hay exactamente uno, ese es. Si hay varios, exige elegir: adivinar entre
 * dueños sería justo el tipo de error que la regla dura 9 existe para evitar.
 */
export async function resolveActor(db: Db, explicit?: string | null): Promise<Result<Uuid>> {
  if (explicit) {
    const { rows } = await db.query<{ id: string }>(`select id from owners where id = $1`, [explicit]);
    if (rows.length === 0) return err('not_found', `No existe el dueño ${explicit}.`);
    return ok(rows[0]!.id);
  }
  const owners = await listOwners(db);
  if (owners.length === 0) return err('not_found', 'No hay ningún dueño todavía. Corre "dm init".');
  if (owners.length > 1) {
    return err('ambiguous', 'Hay más de un dueño: indica cuál con --actor <id> o DM_OWNER_ID.', {
      owners: owners.map((o) => ({ id: o.id, label: o.label })),
    });
  }
  return ok(owners[0]!.id);
}
