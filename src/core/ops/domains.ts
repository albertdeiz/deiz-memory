import type { Actor, Uuid } from '../domain/types';
import type { Db, Deps } from '../ports';
import { err, needsConfirmation, ok, type Result } from '../result';

/**
 * Los dominios de §9.
 *
 * There is no hard delete, and that is not an omission: deleting a domain with
 * memories inside would orphan them or — worse — take them along. The two honest
 * operations are **archive** and **merge**, and in practice merge is the one used
 * 90% of the time, when you realise two categories were always the same one.
 */
export interface Domain {
  id: Uuid;
  slug: string;
  label: string;
  description: string;
  aliases: string[];
  active: boolean;
  /** How many memories it holds. The listing asks for it. */
  count?: number;
}

interface Row {
  id: string; slug: string; label: string; description: string;
  aliases: string[]; active: boolean; n?: string;
}

const toDomain = (r: Row): Domain => ({
  id: r.id,
  slug: r.slug,
  label: r.label,
  description: r.description,
  aliases: r.aliases ?? [],
  active: r.active,
  ...(r.n === undefined ? {} : { count: Number(r.n) }),
});

/** A slug is for typing into a command: unaccented, no spaces, short. */
export const slugify = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

export async function listDomains(
  db: Db,
  actor: Actor,
  opts: { includeArchived?: boolean } = {},
): Promise<Domain[]> {
  const { rows } = await db.query<Row>(
    `select d.id, d.slug, d.label, d.description, d.aliases, d.active,
            count(m.id)::text as n
       from domains d
       left join memories m on m.domain_id = d.id and not m.hidden
      where d.owner_id = $1 and ($2 or d.active)
      group by d.id
      order by d.active desc, d.label`,
    [actor.ownerId, opts.includeArchived ?? false],
  );
  return rows.map(toDomain);
}

/**
 * The active domains, to assemble the classifier's prompt at runtime.
 *
 * This is why it is a table and not an enum: adding a category must not require
 * no puede requerir un deploy (§3.7).
 */
export async function activeDomains(db: Db, actor: Actor): Promise<Domain[]> {
  const { rows } = await db.query<Row>(
    `select id, slug, label, description, aliases, active from domains
      where owner_id = $1 and active order by label`,
    [actor.ownerId],
  );
  return rows.map(toDomain);
}

export async function findDomain(db: Db, actor: Actor, ref: string): Promise<Domain | null> {
  const clean = ref.trim().toLowerCase();
  const { rows } = await db.query<Row>(
    `select id, slug, label, description, aliases, active from domains
      where owner_id = $1 and (slug = $2 or lower(label) = $2 or $2 = any(aliases))
      limit 1`,
    [actor.ownerId, clean],
  );
  return rows.length ? toDomain(rows[0]!) : null;
}

export interface CreateDomainInput {
  label: string;
  description: string;
  aliases?: string[];
  /** Saltarse el aviso de solapamiento. */
  confirm?: boolean;
}

/** Below this, two descriptions are close enough to warn about. */
const OVERLAP_WORDS = 3;

/**
 * Crea un dominio.
 *
 * Proliferation is **the** failure mode: creating categories unchecked ends in
 * forty domains with half of them overlapping. So before creating, the new
 * description is compared against the ones that already exist and a warning is
 * raised — the bot proposes, it never creates on its own.
 */
export async function createDomain(
  db: Db,
  actor: Actor,
  input: CreateDomainInput,
): Promise<Result<Domain>> {
  const label = input.label.trim();
  const description = input.description.trim();
  if (!label) return err('invalid', 'El dominio necesita un nombre.');
  if (!description) {
    // Not bureaucracy: the description IS the classifier's prompt.
    return err('invalid', 'El dominio necesita una descripción de una línea: es lo que usa el clasificador para decidir.');
  }

  const slug = slugify(label);
  if (!slug) return err('invalid', `"${label}" no da un slug usable.`);

  const existing = await findDomain(db, actor, slug);
  if (existing) return err('conflict', `Ya existe "${existing.label}" (/${existing.slug}).`);

  if (!input.confirm) {
    const parecido = await mostSimilar(db, actor, description);
    if (parecido) {
      return needsConfirmation(
        `Esto se parece bastante a "${parecido.label}" (/${parecido.slug}): ${parecido.description}. ` +
          'Tener dos categorías que se solapan las vuelve inútiles a las dos.',
        [{ kind: 'domain', id: parecido.id, label: parecido.label }],
      );
    }
  }

  const { rows } = await db.query<Row>(
    `insert into domains (owner_id, slug, label, description, aliases)
     values ($1, $2, $3, $4, $5) returning id, slug, label, description, aliases, active`,
    [actor.ownerId, slug, label, description, input.aliases ?? []],
  );
  return ok(toDomain(rows[0]!));
}

/** Words shared between descriptions. Crude on purpose: it only warns. */
async function mostSimilar(db: Db, actor: Actor, description: string): Promise<Domain | null> {
  const words = new Set(
    description.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/).filter((w) => w.length > 3),
  );
  if (words.size === 0) return null;

  for (const d of await activeDomains(db, actor)) {
    const suyas = new Set(
      d.description.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9]+/).filter((w) => w.length > 3),
    );
    let shared = 0;
    for (const w of words) if (suyas.has(w)) shared++;
    if (shared >= OVERLAP_WORDS) return d;
  }
  return null;
}

export async function editDomain(
  db: Db,
  actor: Actor,
  ref: string,
  patch: { label?: string; description?: string; aliases?: string[] },
): Promise<Result<Domain>> {
  const d = await findDomain(db, actor, ref);
  if (!d) return err('not_found', `No existe el dominio "${ref}".`);

  // The slug is NOT regenerated on rename. The identity is the id, and changing
  // the slug would break the commands the person already has memorised.
  const { rows } = await db.query<Row>(
    `update domains set label = coalesce($3, label),
                        description = coalesce($4, description),
                        aliases = coalesce($5, aliases),
                        updated_at = now()
      where id = $1 and owner_id = $2
      returning id, slug, label, description, aliases, active`,
    [d.id, actor.ownerId, patch.label ?? null, patch.description ?? null, patch.aliases ?? null],
  );
  return ok(toDomain(rows[0]!));
}

/** Archive: stops being offered when classifying; its memories stay. */
export async function archiveDomain(db: Db, actor: Actor, ref: string): Promise<Result<Domain>> {
  const d = await findDomain(db, actor, ref);
  if (!d) return err('not_found', `No existe el dominio "${ref}".`);
  const { rows } = await db.query<Row>(
    `update domains set active = false, updated_at = now()
      where id = $1 and owner_id = $2
      returning id, slug, label, description, aliases, active`,
    [d.id, actor.ownerId],
  );
  return ok(toDomain(rows[0]!));
}

export interface MergeResult {
  from: Domain;
  into: Domain;
  moved: number;
}

/**
 * Fusionar: mueve las memorias de A a B y archiva A.
 *
 * This is the operation actually used when you realise two categories were the
 * same one. It asks for confirmation because it moves memories, and it names
 * how many.
 */
export async function mergeDomains(
  deps: Deps,
  actor: Actor,
  fromRef: string,
  intoRef: string,
  opts: { confirm?: boolean } = {},
): Promise<Result<MergeResult>> {
  const from = await findDomain(deps.db, actor, fromRef);
  if (!from) return err('not_found', `No existe el dominio "${fromRef}".`);
  const into = await findDomain(deps.db, actor, intoRef);
  if (!into) return err('not_found', `No existe el dominio "${intoRef}".`);
  if (from.id === into.id) return err('invalid', 'Son el mismo dominio.');

  const { rows } = await deps.db.query<{ n: string }>(
    `select count(*)::text n from memories where owner_id = $1 and domain_id = $2`,
    [actor.ownerId, from.id],
  );
  const moved = Number(rows[0]!.n);

  if (!opts.confirm) {
    return needsConfirmation(
      `Fusionar mueve ${moved} memoria(s) de "${from.label}" a "${into.label}" y archiva "${from.label}". ` +
        'Las memorias no se tocan, solo cambian de categoría.',
      [
        { kind: 'domain', id: from.id, label: `${from.label} → ${into.label}` },
        { kind: 'memories', id: String(moved), label: `${moved} memoria(s)` },
      ],
    );
  }

  await deps.db.tx(async (tx) => {
    await tx.query(
      `update memories set domain_id = $3, updated_at = now()
        where owner_id = $1 and domain_id = $2`,
      [actor.ownerId, from.id, into.id],
    );
    await tx.query(`update domains set active = false, updated_at = now() where id = $1`, [from.id]);
  });

  return ok({ from, into, moved });
}

/**
 * La semilla de §9, contexto Chile.
 *
 * Lives here and not only in a migration because a new owner needs it too, and
 * reading it from the table would be circular: a freshly created database has
 * nothing to copy from.
 *
 *
 *
 * A seed, not a closed list: renamed, archived and merged from the chat.
 * chat sin tocar el repo (§3.7).
 */
export const SEED_DOMAINS: { slug: string; label: string; description: string }[] = [
  { slug: 'salud', label: 'Salud',
    description: 'Consultas médicas, recetas, exámenes, medicamentos, alergias, vacunas, Isapre o Fonasa, bonos y reembolsos' },
  { slug: 'seguros', label: 'Seguros',
    description: 'Pólizas de salud complementario, auto, hogar y vida: coberturas, deducibles, teléfonos de asistencia, número de póliza' },
  { slug: 'vehiculo', label: 'Vehículo',
    description: 'Patente, revisión técnica, permiso de circulación, SOAP, mantenciones y reparaciones del auto' },
  { slug: 'documentos', label: 'Documentos',
    description: 'Cédula de identidad, pasaporte, licencia de conducir, certificados civiles y de antecedentes' },
  { slug: 'finanzas', label: 'Finanzas',
    description: 'Suscripciones, pagos recurrentes, garantías de compras, boletas, comprobantes y estados de cuenta' },
  { slug: 'trabajo', label: 'Trabajo',
    description: 'Contratos, decisiones, contactos y compromisos laborales' },
  { slug: 'hogar', label: 'Hogar',
    description: 'Garantías de electrodomésticos, técnicos de confianza, medidas, contratos de arriendo y gastos comunes' },
  { slug: 'personas', label: 'Personas',
    description: 'Cumpleaños, tallas, preferencias, contactos de emergencia y datos de gente cercana' },
];

/** A new owner is born with the seed. Idempotent. */
export async function seedDomains(db: Db, ownerId: Uuid): Promise<void> {
  for (const d of SEED_DOMAINS) {
    await db.query(
      `insert into domains (owner_id, slug, label, description) values ($1, $2, $3, $4)
       on conflict (owner_id, slug) do nothing`,
      [ownerId, d.slug, d.label, d.description],
    );
  }
}
