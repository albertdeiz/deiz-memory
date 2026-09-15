import type { Actor } from '../domain/types';
import type { Deps } from '../ports';
import { err, needsConfirmation, ok, type Result } from '../result';
import { findFactType, listFactTypes, validateCardinality } from './registry';
import type { Cardinality, FactField, FactKind, FactType, FieldKind } from './types';

/**
 * Editing the registry through a channel, which until now had no door.
 *
 * A type could be born two ways — a seed, or accepting a proposal — and after
 * that it was unreachable. Adjusting a `near` anchor, pointing a type at another
 * category or fixing a wrong `kind` all meant `psql`, and a rule that only holds
 * when someone opens a shell is not a rule: it is the thing §11 exists to stop
 * ("one operation, one name, in every channel").
 *
 * So this is the shared middle the CLI and the web both call. Every check lives
 * here rather than in either of them, because the day a validation lives in a
 * route, the two channels start disagreeing about what a valid type is.
 */

const KINDS: readonly FieldKind[] = ['text', 'number', 'uf', 'money', 'date', 'phone'];

export interface FactTypeInput {
  slug?: string;
  label: string;
  description: string;
  kind: FactKind;
  cardinality?: Cardinality;
  domainSlug?: string | null;
  fields: FactField[];
  identityField?: string | null;
  validFromField?: string | null;
  validUntilField?: string | null;
}

export const slugify = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * Everything that has to be true for a type to be able to do its job.
 *
 * Each one is a way to be broken that costs data rather than an error: a field
 * kind outside the closed set leaves validation with nothing to check against,
 * an `identity_field` naming a field that does not exist makes every fact its
 * own instance, and a `many` type without identity loses a row per document on
 * insert, silently.
 */
function check(input: FactTypeInput, domains: string[]): string | null {
  const label = input.label?.trim();
  const description = input.description?.trim();
  if (!label) return 'El tipo necesita un nombre.';
  // The description is not documentation: the model reads it to decide whether a
  // document is of this type (§4). One that says nothing classifies nothing.
  if (!description || description.length < 20) {
    return 'La descripción es el prompt: di para qué documentos aplica, y para cuáles NO.';
  }
  if (input.kind !== 'state' && input.kind !== 'period') {
    return 'kind tiene que ser "state" (uno vigente, sucede) o "period" (coexisten).';
  }

  const cardinality = input.cardinality ?? 'one';
  if (cardinality !== 'one' && cardinality !== 'many') {
    return 'cardinality tiene que ser "one" o "many".';
  }

  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    return 'Un tipo sin campos no extrae nada.';
  }

  const names = new Set<string>();
  for (const f of input.fields) {
    const name = slugify(f.name ?? '');
    if (!name) return 'Cada campo necesita un nombre.';
    if (names.has(name)) return `El campo "${name}" está dos veces.`;
    if (!KINDS.includes(f.kind)) {
      return `"${f.kind}" no es un tipo de campo. Hay: ${KINDS.join(' · ')}.`;
    }
    names.add(name);
  }

  for (const [field, value] of [
    ['identity_field', input.identityField],
    ['valid_from_field', input.validFromField],
    ['valid_until_field', input.validUntilField],
  ] as const) {
    if (value && !names.has(slugify(value))) {
      return `${field} apunta a "${value}", que no es uno de los campos.`;
    }
  }

  const cardErr = validateCardinality({ cardinality, identityField: input.identityField ?? null });
  if (cardErr) return cardErr;

  // A `state` that cannot supersede is a `state` in name only, and the failure
  // shows up as two live facts that should have been one.
  if (input.kind === 'state' && !input.identityField) {
    return 'Un tipo "state" necesita identity_field: sin él nunca podría superseder, que es su razón de ser.';
  }

  if (input.domainSlug && !domains.includes(input.domainSlug)) {
    return `No existe la categoría "${input.domainSlug}".`;
  }
  return null;
}

const normalize = (input: FactTypeInput): FactTypeInput => ({
  ...input,
  slug: slugify(input.slug || input.label),
  label: input.label.trim(),
  description: input.description.trim(),
  cardinality: input.cardinality ?? 'one',
  domainSlug: input.domainSlug ?? null,
  fields: input.fields.map((f) => ({
    ...f,
    name: slugify(f.name),
    label: (f.label ?? f.name).trim(),
    aliases: (f.aliases ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean),
  })),
  identityField: input.identityField ? slugify(input.identityField) : null,
  validFromField: input.validFromField ? slugify(input.validFromField) : null,
  validUntilField: input.validUntilField ? slugify(input.validUntilField) : null,
});

async function activeDomainSlugs(deps: Deps, actor: Actor): Promise<string[]> {
  const { rows } = await deps.db.query<{ slug: string }>(
    `select slug from domains where owner_id = $1 and active`, [actor.ownerId],
  );
  return rows.map((r) => r.slug);
}

export async function createFactType(
  deps: Deps,
  actor: Actor,
  raw: FactTypeInput,
): Promise<Result<FactType>> {
  const input = normalize(raw);
  const problem = check(input, await activeDomainSlugs(deps, actor));
  if (problem) return err('invalid', problem);

  const existing = await listFactTypes(deps.db, actor, { includeInactive: true });
  if (existing.some((t) => t.slug === input.slug)) {
    return err('conflict', `Ya existe un tipo "${input.slug}".`);
  }

  await deps.db.query(
    `insert into fact_types
       (owner_id, slug, label, description, kind, cardinality, domain_slug, fields,
        identity_field, valid_from_field, valid_until_field)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [actor.ownerId, input.slug, input.label, input.description, input.kind,
     input.cardinality, input.domainSlug, JSON.stringify(input.fields),
     input.identityField, input.validFromField, input.validUntilField],
  );

  // By slug and not by the id it just returned: `findFactType` resolves a slug
  // or a label, never a uuid. Handing it one silently finds nothing, which came
  // back as "se creó pero no se pudo leer de vuelta" on a row that was fine.
  const created = await findFactType(deps.db, actor, input.slug!);
  return created ? ok(created) : err('invalid', 'Se creó pero no se pudo leer de vuelta.');
}

export type FactTypePatch = Partial<Omit<FactTypeInput, 'slug'>>;

/**
 * Editing asks first, and not out of politeness.
 *
 * A type decides how every document of its category is read. Moving `domainSlug`
 * stops it applying where it did and starts applying where it did not; changing
 * `kind` from period to state would make August supersede July. The caller is
 * handed what would change and asks, the same way §13.7 requires for a category.
 */
export async function editFactType(
  deps: Deps,
  actor: Actor,
  ref: string,
  patch: FactTypePatch,
  opts: { confirm?: boolean } = {},
): Promise<Result<FactType>> {
  const current = await findFactType(deps.db, actor, ref);
  if (!current) return err('not_found', `No existe el tipo "${ref}".`);

  const merged = normalize({ ...current, ...patch, slug: current.slug });
  const problem = check(merged, await activeDomainSlugs(deps, actor));
  if (problem) return err('invalid', problem);

  const changed = (['label', 'description', 'kind', 'cardinality', 'domainSlug',
    'identityField', 'validFromField', 'validUntilField'] as const)
    .filter((k) => JSON.stringify(merged[k]) !== JSON.stringify(current[k]));
  if (JSON.stringify(merged.fields) !== JSON.stringify(current.fields)) changed.push('fields' as never);
  if (changed.length === 0) return ok(current);

  // The two that change how existing facts are read, rather than how new ones
  // are extracted. Everything else is a wording change.
  const heavy = changed.some((k) => k === 'kind' || k === 'cardinality' || k === 'domainSlug');
  if (heavy && !opts.confirm) {
    return needsConfirmation(
      `Cambiar ${changed.join(', ')} en "${current.label}" decide cómo se leen TODOS los ` +
        'documentos de esa categoría. Los hechos ya extraídos no cambian solos: ' +
        'corre dm facts extract después.',
      [{ kind: 'fact_type', id: current.slug, label: current.label }],
    );
  }

  await deps.db.query(
    `update fact_types
        set label = $3, description = $4, kind = $5, cardinality = $6,
            domain_slug = $7, fields = $8::jsonb, identity_field = $9,
            valid_from_field = $10, valid_until_field = $11
      where id = $1 and owner_id = $2`,
    [current.id, actor.ownerId, merged.label, merged.description, merged.kind,
     merged.cardinality, merged.domainSlug, JSON.stringify(merged.fields),
     merged.identityField, merged.validFromField, merged.validUntilField],
  );

  const after = await findFactType(deps.db, actor, current.slug);
  return after ? ok(after) : err('invalid', 'Se editó pero no se pudo leer de vuelta.');
}

/**
 * Archiving and not deleting, for the same reason as a domain (§9).
 *
 * The facts it extracted stay and stay citable: they came from a document and
 * that document still says what it says. What stops is extracting more.
 */
export async function archiveFactType(
  deps: Deps,
  actor: Actor,
  ref: string,
): Promise<Result<FactType>> {
  const current = await findFactType(deps.db, actor, ref);
  if (!current) return err('not_found', `No existe el tipo "${ref}".`);

  await deps.db.query(
    `update fact_types set active = false where id = $1 and owner_id = $2`,
    [current.id, actor.ownerId],
  );
  const after = await findFactType(deps.db, actor, current.slug);
  return after ? ok(after) : err('invalid', 'Se archivó pero no se pudo leer de vuelta.');
}
