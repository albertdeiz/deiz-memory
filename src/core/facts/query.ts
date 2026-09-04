import type { Actor, Uuid } from '../domain/types';
import { shortId } from '../domain/types';
import type { Db } from '../ports';
import { listFactTypes } from './registry';
import type { Fact, FactField, FactType } from './types';

interface Row {
  id: string; memory_id: string; type_id: string; payload: Record<string, string | number>;
  identity: string | null; valid_from: Date | null; valid_until: Date | null;
  superseded_by: string | null; confidence: number;
  slug: string; label: string; kind: string; title: string | null;
}

const toFact = (r: Row): Fact => ({
  id: r.id,
  memoryId: r.memory_id,
  typeId: r.type_id,
  typeSlug: r.slug,
  typeLabel: r.label,
  kind: r.kind as Fact['kind'],
  payload: r.payload ?? {},
  identity: r.identity,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
  supersededBy: r.superseded_by,
  confidence: r.confidence,
  shortId: shortId(r.memory_id),
  memoryTitle: r.title,
});

const SELECT = `
  select f.id, f.memory_id, f.type_id, f.payload, f.identity, f.valid_from,
         f.valid_until, f.superseded_by, f.confidence,
         t.slug, t.label, t.kind, m.title
    from facts f
    join fact_types t on t.id = f.type_id
    join memories m on m.id = f.memory_id`;

export async function listFacts(
  db: Db,
  actor: Actor,
  opts: { includeSuperseded?: boolean } = {},
): Promise<Fact[]> {
  const { rows } = await db.query<Row>(
    `${SELECT}
      where f.owner_id = $1 and not m.hidden
        and ($2 or f.superseded_by is null)
      order by t.label, coalesce(f.valid_from, f.extracted_at::date) desc`,
    [actor.ownerId, opts.includeSuperseded ?? false],
  );
  return rows.map(toFact);
}

export async function factsForMemory(db: Db, actor: Actor, memoryId: Uuid): Promise<Fact[]> {
  const { rows } = await db.query<Row>(
    `${SELECT} where f.owner_id = $1 and f.memory_id = $2`,
    [actor.ownerId, memoryId],
  );
  return rows.map(toFact);
}

/** A field of a type, which is what a question may be asking for. */
export interface FieldRef {
  type: FactType;
  field: FactField;
}

const withoutAccents = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * The approximate stem of a Spanish word.
 *
 * Without this the match was by exact word, and asking "how much does my card
 * pay" missed an alias in the infinitive. Asking whoever defines a type to
 * enumerate every conjugation is asking them to conjugate: the system can do it.
 *
 * The plural comes off first, then the verb ending or the final vowel, keeping
 * at least three letters, so all forms of the same verb land on one stem.
 */
const stem = (w: string): string => {
  let x = withoutAccents(w);
  if (x.length > 4 && x.endsWith('es')) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s')) x = x.slice(0, -1);
  if (x.length > 3 && x.endsWith('r')) x = x.slice(0, -1);
  if (x.length > 3 && /[aeiou]$/.test(x)) x = x.slice(0, -1);
  return x;
};

/**
 * Two words refer to the same thing.
 *
 * By prefix and not by equality, because a short form and its long noun are the
 * same question and no reasonable stem joins them. Three letters minimum: with
 * two, unrelated words would start colliding.
 */
const sameIdea = (a: string, b: string): boolean => {
  const [x, y] = [stem(a), stem(b)];
  const shorter = x.length <= y.length ? x : y;
  return shorter.length >= 3 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * Which field this question is asking for, if any.
 *
 * **Without calling a model.** The registry's aliases exist exactly for this: if
 * a word of the question matches one, there is a fact path. Having a model pick
 * the field would put an unverifiable decision in the one path of the system
 * that is exact.
 *
 * When more than one type shares an alias — "expires" fits a policy and a card —
 * all of them come back and the asker decides, since they may have named the
 * type.
 */
export function matchFields(question: string, types: FactType[]): FieldRef[] {
  const words = new Set(
    withoutAccents(question).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2),
  );
  if (words.size === 0) return [];

  const out: FieldRef[] = [];
  for (const type of types) {
    // Naming the type narrows: "my car's deductible" versus "my card's".
    const named = withoutAccents(type.label).split(/\s+/).some((w) => w.length > 3 && words.has(w));
    for (const field of type.fields) {
      if (field.aliases.some((a) => [...words].some((p) => sameIdea(p, a)))) {
        out.push({ type, field });
      }
    }
    if (named) {
      // A named type beats one that merely shares an alias.
      const own = out.filter((r) => r.type.id === type.id);
      if (own.length > 0) return own;
    }
  }
  return out;
}

export interface FactHit {
  ref: FieldRef;
  fact: Fact;
  value: string | number;
  /** No longer valid: said BEFORE the datum, never after. */
  expired: boolean;
  /** Replaced by a later one. Also said before. */
  superseded: boolean;
}

/**
 * The facts that answer this question.
 *
 * Returns **all** that apply, not the best one: with two live policies carrying
 * different deductibles, both are shown. Choosing silently is the failure mode
 * this path exists to avoid.
 */
export async function askFacts(
  db: Db,
  actor: Actor,
  question: string,
  now: Date,
): Promise<FactHit[]> {
  const types = await listFactTypes(db, actor);
  const refs = matchFields(question, types);
  if (refs.length === 0) return [];

  // Superseded facts are included: if that is all there is, the correct answer
  // is not "I do not have it" but "what I have is superseded, and it says this".
  const facts = await listFacts(db, actor, { includeSuperseded: true });
  const today = now.toISOString().slice(0, 10);

  const hits: FactHit[] = [];
  for (const ref of refs) {
    for (const fact of facts) {
      if (fact.typeId !== ref.type.id) continue;
      const value = fact.payload[ref.field.name];
      if (value === undefined) continue;
      const until = fact.validUntil?.toISOString().slice(0, 10) ?? null;
      hits.push({
        ref,
        fact,
        value,
        // A `period` has no notion of expiry: July's statement did not expire,
        // it is still the truth about July.
        expired: ref.type.kind === 'state' && until !== null && until < today,
        superseded: fact.supersededBy !== null,
      });
    }
  }

  // Live first, and within that the most recent. A `period` answers with its
  // latest window unless the question names another.
  return hits.sort((a, b) => {
    const live = Number(a.expired || a.superseded) - Number(b.expired || b.superseded);
    if (live !== 0) return live;
    const fa = a.fact.validFrom?.getTime() ?? 0;
    const fb = b.fact.validFrom?.getTime() ?? 0;
    return fb - fa;
  });
}
