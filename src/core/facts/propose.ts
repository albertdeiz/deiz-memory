import type { Actor, Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import type { Deps } from '../ports';
import { err, needsConfirmation, ok, type Result } from '../result';
import { listFactTypes, typesForDomain, validateCardinality } from './registry';
import { relevantContext } from './prompt';
import { coerce, grounded } from './values';
import type { Cardinality, FactField, FactKind, FactType, FieldKind } from './types';

/**
 * Emergent fact types (§4, §9).
 *
 * Same idea as emergent domains and the same hard rule on top: **the system
 * proposes, it never creates on its own.** What changes is the signal, and for
 * types it is sharper than for domains — there is no guessing at what fits
 * nowhere, because the registry already says which documents nothing applies to:
 *
 *  · a document in a category with no fact type at all, or
 *  · one where every applicable type answered `aplica: false`.
 *
 * That set is literally "this has extractable structure nobody declared".
 *
 * The other difference is the cost. Proposing a domain is a sentence and stays
 * deterministic; proposing a type is a `fields[]` with names, kinds and aliases,
 * so it needs the model. Which means it also needs the same discipline §4
 * applies to extraction: **what the model proposes is verified against the
 * document before it is offered**, and a field whose example value is not in the
 * text is dropped. A type invented out of nothing would produce facts out of
 * nothing.
 */

const KINDS: readonly FieldKind[] = ['text', 'number', 'uf', 'money', 'date', 'phone'];

/**
 * A type is worth a row from a single document, unlike a domain.
 *
 * §9 waits for three because a category exists to group things. A type exists to
 * read one document well, and you have exactly one identity card — demanding
 * three would mean never getting a type for the documents that matter most.
 */
export const MIN_DOCS = 1;

/** Below this many usable fields a type is not worth the row. */
const MIN_FIELDS = 2;

/**
 * Names that are the schema's own, not a document's.
 *
 * Measured: the model put `identity_field` and `valid_until_field` INSIDE
 * `campos`, as if they were data. They passed grounding — a date is a date — and
 * would have become columns named after the thing that was supposed to point at
 * a column.
 */
const RESERVED = new Set([
  'identity_field', 'valid_from_field', 'valid_until_field',
  'campos', 'slug', 'label', 'description', 'kind', 'vale_la_pena', 'ejemplo',
]);

export interface FieldProposal extends FactField {
  /** What the model found in the document, kept so you can judge by looking. */
  example: string;
}

export interface TypeProposal {
  slug: string;
  label: string;
  description: string;
  kind: FactKind;
  cardinality: Cardinality;
  domainSlug: string;
  fields: FieldProposal[];
  identityField: string | null;
  validFromField: string | null;
  validUntilField: string | null;
  /** Where it came from, so the proposal can be judged against the real thing. */
  fromMemoryId: Uuid;
  fromShortId: string;
  fromTitle: string | null;
  /** Fields the model proposed that the document did not back. */
  discarded: string[];
}

interface Candidate {
  id: Uuid;
  title: string | null;
  note: string | null;
  normalized_text: string;
  domain_slug: string;
}

/**
 * Documents nothing can read yet.
 *
 * `not exists (... facts ...)` is the whole filter and it covers both cases at
 * once: no type for the category, and a type that looked and said no. Both end
 * the same way — a document with structure and no row describing it.
 */
async function orphans(deps: Deps, actor: Actor): Promise<Candidate[]> {
  const { rows } = await deps.db.query<Candidate>(
    `select m.id, m.title, m.note, m.normalized_text, d.slug as domain_slug
       from memories m
       join domains d on d.id = m.domain_id
      where m.owner_id = $1 and not m.hidden
        and m.normalized_text is not null and length(m.normalized_text) > 200
        and not exists (select 1 from facts f where f.memory_id = m.id)
      order by m.captured_at desc`,
    [actor.ownerId],
  );
  return rows;
}

const proposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['vale_la_pena', 'slug', 'label', 'description', 'kind', 'campos'],
  properties: {
    vale_la_pena: { type: 'boolean' },
    slug: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
    kind: { type: 'string', enum: ['state', 'period'] },
    cardinality: { type: 'string', enum: ['one', 'many'] },
    identity_field: { type: ['string', 'null'] },
    valid_from_field: { type: ['string', 'null'] },
    valid_until_field: { type: ['string', 'null'] },
    campos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'label', 'kind', 'aliases', 'ejemplo'],
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string', enum: [...KINDS] },
          aliases: { type: 'array', items: { type: 'string' } },
          ejemplo: { type: 'string' },
        },
      },
    },
  },
} as const;

function buildPrompt(c: Candidate, existing: FactType[]): { system: string; user: string } {
  const taken = existing.map((t) => `${t.slug} (${t.label})`).join(', ') || 'ninguno';
  const system = [
    'Diseñas el esquema para extraer datos duros de documentos personales en Chile.',
    'Respondes solo JSON.',
    '',
    'Te doy UN documento. Propones el tipo que lo describe, para poder extraer los',
    'mismos datos de otros documentos iguales en el futuro.',
    '',
    `Tipos que ya existen, NO propongas uno que se solape: ${taken}.`,
    '',
    'Reglas:',
    // The first one is what stops a schema being invented for a document that
    // has no stable structure at all — a photo of a note, a receipt.
    '- Si el documento no tiene datos duros estables que valga la pena extraer,',
    '  responde {"vale_la_pena": false} y nada más.',
    '- kind "state": tiene UNO vigente y el nuevo sucede al viejo (una licencia, una',
    '  póliza). kind "period": coexisten, cada uno es la verdad sobre su período',
    '  (una cartola mensual). Confundirlos corrompe datos.',
    // Two axes, and the prompt has to say they are two or the model collapses
    // them: it reads "varios" and reaches for "period".
    '- cardinality "one": el documento trae UN dato de este tipo. "many": trae VARIOS,',
    '  uno por instancia (un PDF con dos pasajes, uno por pasajero). Es una pregunta',
    '  DISTINTA de kind: un pasaje es "period" y "many" a la vez.',
    '- Si propones "many", identity_field es obligatorio: sin él las filas no se',
    '  distinguen. Y no es "many" una tabla que solo sirve sumada — eso queda fuera.',
    '- Cada campo: name en snake_case sin acentos, kind de la lista, aliases con las',
    '  palabras con que una persona preguntaría por ese dato.',
    '- "ejemplo" es el valor REAL que trae este documento, copiado exacto. Se',
    '  comprueba contra el texto: un campo cuyo ejemplo no esté se descarta.',
    '- identity_field: el campo que distingue dos instancias (un RUT, una patente).',
    '- valid_from_field / valid_until_field: los campos de vigencia, si los hay.',
    '- Entre 2 y 8 campos. Solo datos que se consultan, no prosa.',
  ].join('\n');

  const fake: FactType = {
    id: '', slug: '', label: '', description: '', kind: 'state', cardinality: 'one',
    domainSlug: null, fields: [], identityField: null,
    validFromField: null, validUntilField: null, active: true,
  };
  const body = [
    `Categoría: ${c.domain_slug}`,
    c.title ? `Título: ${c.title}` : '',
    '',
    'Documento:',
    relevantContext(fake, c.normalized_text),
  ].filter(Boolean).join('\n');

  return { system, user: body };
}

const snake = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * Turns what the model returned into a proposal, or nothing.
 *
 * Everything here is a check the model could fail and a person would not notice:
 * a kind outside the closed set leaves validation with nothing to validate
 * against, an `identity_field` naming a field that does not exist makes every
 * fact its own instance, and a field whose example is absent from the document
 * is a column that will always be null.
 */
function validate(raw: unknown, c: Candidate, existing: FactType[]): TypeProposal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.vale_la_pena === false) return null;

  const slug = snake(String(o.slug ?? ''));
  const label = String(o.label ?? '').trim();
  const description = String(o.description ?? '').trim();
  const kind: FactKind = o.kind === 'period' ? 'period' : 'state';
  const cardinality: Cardinality = o.cardinality === 'many' ? 'many' : 'one';
  if (!slug || !label || description.length < 20) return null;
  if (existing.some((t) => t.slug === slug)) return null;

  const source = [c.note, c.normalized_text].filter(Boolean).join('\n\n');
  const fields: FieldProposal[] = [];
  const discarded: string[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(o.campos) ? o.campos : []) {
    if (typeof item !== 'object' || item === null) continue;
    const f = item as Record<string, unknown>;
    const name = snake(String(f.name ?? ''));
    const fieldKind = String(f.kind ?? '') as FieldKind;
    if (!name || seen.has(name) || RESERVED.has(name) || !KINDS.includes(fieldKind)) continue;
    seen.add(name);

    const field: FactField = {
      name,
      kind: fieldKind,
      label: String(f.label ?? name).trim() || name,
      aliases: (Array.isArray(f.aliases) ? f.aliases : [])
        .map((a) => String(a).trim().toLowerCase())
        .filter((a) => a.length >= 3)
        .slice(0, 6),
    };

    // The same grounding extraction uses. A proposed field whose example is not
    // in the document is a column that would always come back null.
    const example = coerce(f.ejemplo, fieldKind);
    if (example === null || !grounded(example, field, source)) {
      discarded.push(name);
      continue;
    }
    fields.push({ ...field, example: String(f.ejemplo) });
  }

  // Several fields with the SAME example is the model reading a table down a
  // column instead of across a row: a licence proposed `clase`, `actual` and
  // `proximo`, all of them "A1". One datum under three names is worse than one
  // name, because a question would pick whichever it happened to match.
  const byExample = new Map<string, FieldProposal>();
  for (const f of fields) if (!byExample.has(f.example)) byExample.set(f.example, f);
  const unique = [...byExample.values()];
  for (const f of fields) if (!unique.includes(f)) discarded.push(`${f.name} (repetido)`);

  if (unique.length < MIN_FIELDS) return null;

  const names = new Set(unique.map((f) => f.name));
  const pick = (v: unknown): string | null => {
    const n = snake(String(v ?? ''));
    return n && names.has(n) ? n : null;
  };

  const identityField = pick(o.identity_field);

  // A `state` type without an identity can never supersede anything, and
  // superseding is the entire reason `state` exists (§4). Offering one would be
  // offering a type that silently fails at its job, so it is not offered.
  if (kind === 'state' && !identityField) return null;

  // And a `many` one fails worse: two rows from the same document collapse into
  // one on insert, so the second datum disappears with nothing reporting it.
  if (validateCardinality({ cardinality, identityField })) return null;

  return {
    slug, label, description, kind, cardinality,
    domainSlug: c.domain_slug,
    fields: unique,
    identityField,
    validFromField: pick(o.valid_from_field),
    validUntilField: pick(o.valid_until_field),
    fromMemoryId: c.id,
    fromShortId: shortId(c.id),
    fromTitle: c.title,
    discarded,
  };
}

/**
 * Looks at what no type can read and proposes the types that would.
 *
 * One proposal per slug: two identity cards should not produce two proposals for
 * the same thing, which is the proliferation §9 warns about in its own domain.
 */
export async function proposeFactTypes(
  deps: Deps,
  actor: Actor,
  opts: { limit?: number } = {},
): Promise<Result<TypeProposal[]>> {
  if (!deps.classifier) return err('invalid', 'No hay modelo para proponer tipos.');

  const candidates = await orphans(deps, actor);
  if (candidates.length < MIN_DOCS) return ok([]);

  const existing = await listFactTypes(deps.db, actor, { includeInactive: true });
  const out: TypeProposal[] = [];
  const proposed = new Set<string>();

  for (const c of candidates.slice(0, opts.limit ?? 12)) {
    // A category that already reads this document needs no new type: the
    // orphan query cannot tell "no type" from "the type said no", and only the
    // first is worth proposing for.
    const applicable = await typesForDomain(deps.db, actor.ownerId, c.domain_slug);
    if (applicable.length > 0) continue;

    const { system, user } = buildPrompt(c, existing);
    let raw: unknown;
    try {
      raw = await deps.classifier.classify({ system, user, schema: proposalSchema });
    } catch {
      continue; // One document failing does not take the rest with it.
    }

    const p = validate(raw, c, existing);
    if (!p || proposed.has(p.slug)) continue;
    proposed.add(p.slug);
    out.push(p);
  }

  return ok(out);
}

export interface AcceptedType {
  slug: string;
  label: string;
  fields: number;
}

/**
 * Turns a proposal into a row, and nothing else happens on its own.
 *
 * Confirmation is not politeness: a type decides how every future document of
 * its category is read, and `kind` in particular cannot be guessed twice —
 * marking a monthly statement as `state` would have August supersede July, which
 * §4 calls worse than not having the datum. So the caller is handed the shape
 * and asked, exactly as §13.7 requires for a category.
 *
 * Nothing is extracted here. Creating the type and re-reading the corpus with it
 * are separate decisions, and the second one is `dm facts extract`.
 */
export async function acceptFactType(
  deps: Deps,
  actor: Actor,
  p: TypeProposal,
  opts: { confirm: boolean },
): Promise<Result<AcceptedType>> {
  const existing = await listFactTypes(deps.db, actor, { includeInactive: true });
  if (existing.some((t) => t.slug === p.slug)) {
    return err('conflict', `Ya existe un tipo ${p.slug}.`);
  }

  if (!opts.confirm) {
    return needsConfirmation(
      `Crear el tipo "${p.label}" (${p.kind === 'state' ? 'estado' : 'período'}` +
        // Said out loud, because it is the half that is easy to get wrong and
        // expensive to fix: `many` decides whether a document's second row lives.
        `${p.cardinality === 'many' ? ', varios por documento' : ''}) sobre ${p.domainSlug}, ` +
        `con ${p.fields.length} campos. Un tipo decide cómo se leen todos los documentos ` +
        `futuros de esa categoría.`,
      [{ kind: 'fact_type', id: p.slug, label: p.label }],
    );
  }

  await deps.db.query(
    `insert into fact_types
       (owner_id, slug, label, description, kind, cardinality, domain_slug, fields,
        identity_field, valid_from_field, valid_until_field)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [
      actor.ownerId, p.slug, p.label, p.description, p.kind, p.cardinality, p.domainSlug,
      // The example is what made the proposal judgeable; it is not part of the
      // type, so it does not travel into the registry.
      JSON.stringify(p.fields.map(({ example: _e, ...f }) => f)),
      p.identityField, p.validFromField, p.validUntilField,
    ],
  );

  return ok({ slug: p.slug, label: p.label, fields: p.fields.length });
}
