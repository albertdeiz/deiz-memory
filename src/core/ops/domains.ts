import type { Actor, Uuid } from '../domain/types.js';
import type { Db, Deps } from '../ports.js';
import { err, needsConfirmation, ok, type Result } from '../result.js';

/**
 * Los dominios de §9.
 *
 * No hay borrado duro, y no es una omisión: eliminar un dominio con memorias
 * adentro las dejaría huérfanas o —peor— se las llevaría. Las dos operaciones
 * honestas son **archivar** y **fusionar**, y en la práctica fusionar es la que
 * se usa el 90% de las veces ("esto de 'papeles' en realidad era 'documentos'").
 */
export interface Domain {
  id: Uuid;
  slug: string;
  label: string;
  description: string;
  aliases: string[];
  active: boolean;
  /** Cuántas memorias tiene. Lo pide `/dominios` (§9). */
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

/** Un slug es para escribirlo en un comando: sin tildes, sin espacios, corto. */
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
 * Los dominios activos, para armar el prompt del clasificador en runtime.
 *
 * Es la razón por la que esto es una tabla y no un enum: agregar una categoría
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

/** Debajo de esto dos descripciones se parecen lo bastante como para avisar. */
const OVERLAP_WORDS = 3;

/**
 * Crea un dominio.
 *
 * §9 nombra la proliferación como **el** modo de falla: crear categorías sin
 * freno termina en cuarenta dominios con la mitad solapados ("salud", "médico",
 * "doctores"). Por eso antes de crear se compara contra las descripciones que
 * ya existen y se avisa — el bot propone, nunca crea solo.
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
    // No es burocracia: la descripción ES el prompt del clasificador (§9).
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

/** Palabras compartidas entre descripciones. Tosco a propósito: solo avisa. */
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

  // El slug NO se regenera al renombrar. La identidad es el id (§9), y cambiar
  // el slug rompería los comandos que la persona ya tiene en la cabeza.
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

/** Archivar: deja de proponerse al clasificar, sus memorias siguen ahí (§9). */
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
 * Es la operación que de verdad se usa cuando te das cuenta de que dos
 * categorías eran la misma. Pide confirmación porque mueve memorias, y nombra
 * cuántas.
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
 * Vive acá y no solo en la migración porque un dueño nuevo también la necesita,
 * y leerla de la tabla sería circular: en una base recién creada no hay de
 * dónde copiar. La 006 la repite para los dueños que ya existían — es una
 * migración, o sea historia congelada, y duplicar una lista de ocho filas es
 * más barato que inventar un mecanismo para compartirla.
 *
 * Es semilla, no lista cerrada: se renombra, se archiva y se fusiona desde el
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

/** Un dueño nuevo nace con la semilla. Idempotente. */
export async function seedDomains(db: Db, ownerId: Uuid): Promise<void> {
  for (const d of SEED_DOMAINS) {
    await db.query(
      `insert into domains (owner_id, slug, label, description) values ($1, $2, $3, $4)
       on conflict (owner_id, slug) do nothing`,
      [ownerId, d.slug, d.label, d.description],
    );
  }
}
