import type { Actor, Uuid } from '../domain/types';
import { findDomain } from '../ops/domains';
import type { Deps } from '../ports';
import { err, ok, type Result } from '../result';

/**
 * Hybrid retrieval.
 *
 * The classic mistake is throwing everything into a vector store and hoping.
 * It does not work for "what is my policy number?": a number resembles nothing
 * semantically, and full-text finds it exactly.
 *
 * So both are used and fused. And before either, **the structured filter**:
 * domain and date window cut the universe down first, which is what actually
 * lowers the noise.
 */
export interface RetrieveInput {
  query: string;
  /** Slug or label of a domain, to narrow. */
  domain?: string | null;
  from?: Date | null;
  until?: Date | null;
  limit?: number;
}

export interface Passage {
  memoryId: Uuid;
  shortId: string;
  title: string | null;
  occurredAt: Date | null;
  capturedAt: Date;
  domainLabel: string | null;
  /** Whether there is a file to offer. A typed note has no original. */
  mediaType: string | null;
  /** The specific chunk that answered, not the whole document. This is the citation. */
  content: string;
  seq: number;
  /** Which path found it: useful for understanding why it showed up. */
  via: 'text' | 'semantic' | 'both';
  score: number;
}

/**
 * A question is not searched with AND.
 *
 * Requiring EVERY term is right when you type an explicit search — you asked
 * for both words. But when asking "what is the deductible on my car
 * insurance?", the paragraph that answers says "deductible" and does not say
 * "car": requiring both discards it. Measured on a real policy: zero chunks
 * with AND, eight with the single word.
 */
const termsOf = (q: string): string[] =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

const anyOf = (q: string): string => termsOf(q).join(' | ') || q;

/** How many of the owner's chunks contain each term. Document frequency. */
async function frequencies(
  db: Deps['db'],
  ownerId: string,
  terms: string[],
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ term: string; n: string }>(
    `select t.term, count(c.*)::text as n
       from unnest($2::text[]) as t(term)
       left join memory_chunks c on c.owner_id = $1
         and to_tsvector('es_unaccent', c.content) @@ to_tsquery('es_unaccent', t.term)
      group by t.term`,
    [ownerId, terms],
  );
  return new Map(rows.map((r) => [r.term, Number(r.n)]));
}

/** A term appearing far more often than the rarest one is topic, not datum. */
const COMMON_FACTOR = 3;

/**
 * Which terms **rank** — which are not the same ones that match.
 *
 * Matching with OR is right: requiring every word of a question discards the
 * paragraph that answers it. But ranking with OR gives full credit to the words
 * that only say *which document* we are talking about, and those are on every
 * page of it.
 *
 * Measured on a car policy: asked "how much is my deductible on my vehicle
 * insurance?", the word for insurance appears in 16% of the chunks and the word
 * for vehicle in 15%, against 4% for deductible. Chunks that merely mentioned
 * the vehicle tied in full-text with the only one carrying the figure, and the
 * vector tied them too — the whole document resembles the question — so the one
 * that answered came **seventh** and the model only reads the first few. With no
 * figure in front of it, declining to answer is correct, and that is what it did.
 *
 * So ranking uses only the rare terms. The common ones stay in the `where` —
 * they add recall, which is what they are for — but stop deciding the order. It
 * is IDF, by hand, with the threshold relative to the rarest term of the
 * question itself so it holds at 40 chunks and at 400.
 */
async function rankTerms(deps: Deps, ownerId: string, q: string): Promise<string> {
  const terms = termsOf(q);
  if (terms.length < 2) return anyOf(q);

  const df = await frequencies(deps.db, ownerId, terms);
  const present = terms.filter((t) => (df.get(t) ?? 0) > 0);
  if (present.length === 0) return anyOf(q);

  const rarest = Math.min(...present.map((t) => df.get(t)!));
  const rare = present.filter((t) => df.get(t)! <= rarest * COMMON_FACTOR);
  return rare.join(' | ') || anyOf(q);
}

const clampLimit = (n: number | undefined) =>
  !n || !Number.isFinite(n) ? 8 : Math.min(Math.max(Math.trunc(n), 1), 30);

/**
 * How much each path weighs when fusing.
 *
 * Full-text weighs more because when it hits, it hits exactly: a tax id, a
 * policy number, a plate. Similarity is what rescues questions written in words
 * other than the document's.
 */
const W_FTS = 1.0;
const W_VEC = 0.85;

interface Row {
  memory_id: string;
  title: string | null;
  occurred_at: Date | null;
  captured_at: Date;
  domain_label: string | null;
  media_type: string | null;
  content: string;
  seq: number;
  score: number;
}

export async function retrieve(
  deps: Deps,
  actor: Actor,
  input: RetrieveInput,
): Promise<Result<Passage[]>> {
  const q = input.query.trim();
  if (!q) return err('invalid', 'Dime qué buscar.');
  const limit = clampLimit(input.limit);

  // 1 · The structured filter, first. Cutting before searching is what makes
  //     this hybrid, and it is what actually lowers the noise.
  let domainId: string | null = null;
  if (input.domain) {
    const d = await findDomain(deps.db, actor, input.domain);
    if (!d) return err('not_found', `No tengo una categoría "${input.domain}".`);
    domainId = d.id;
  }

  const rank = await rankTerms(deps, actor.ownerId, q);

  const scope = `
    m.owner_id = $1 and not m.hidden
    and ($2::uuid is null or m.domain_id = $2)
    and ($3::timestamptz is null or coalesce(m.occurred_at, m.captured_at) >= $3)
    and ($4::timestamptz is null or coalesce(m.occurred_at, m.captured_at) <= $4)`;
  const base = [actor.ownerId, domainId, input.from ?? null, input.until ?? null];

  // 2 · Full-text over the chunks: precise for whatever is written the same way.
  const fts = await deps.db.query<Row>(
    `select c.memory_id, m.title, m.occurred_at, m.captured_at, d.label as domain_label,
            b.media_type, c.content, c.seq,
            ts_rank(to_tsvector('es_unaccent', c.content),
                    to_tsquery('es_unaccent', $7)) as score
       from memory_chunks c
       join memories m on m.id = c.memory_id
       left join domains d on d.id = m.domain_id
       left join blobs b on b.sha256 = m.blob_sha256
      where ${scope}
        and to_tsvector('es_unaccent', c.content) @@ to_tsquery('es_unaccent', $5)
      order by score desc limit $6`,
    [...base, anyOf(q), limit * 2, rank],
  );

  // 3 · Similarity, when there is something to do it with. With no embedder the
  //     system keeps working: it degrades to full-text.
  let vec: { rows: Row[] } = { rows: [] };
  if (deps.embedder) {
    const [v] = await deps.embedder.embed([q]);
    if (v) {
      vec = await deps.db.query<Row>(
        `select c.memory_id, m.title, m.occurred_at, m.captured_at, d.label as domain_label,
                b.media_type, c.content, c.seq,
                1 - (c.embedding <=> $5::vector) as score
           from memory_chunks c
           join memories m on m.id = c.memory_id
           left join domains d on d.id = m.domain_id
           left join blobs b on b.sha256 = m.blob_sha256
          where ${scope} and c.embedding is not null
          order by c.embedding <=> $5::vector limit $6`,
        [...base, JSON.stringify(v), limit * 2],
      );
    }
  }

  return ok(merge(fts.rows, vec.rows, limit));
}

/**
 * Fuses the two paths.
 *
 * Each list is normalized against its own maximum before summing, because rank
 * scores and cosine similarity live on different scales and adding them raw
 * would let one dominate the other by accident of units.
 *
 * A chunk appearing in both lists rises: two independent methods agreeing is the
 * best signal available here.
 */
function merge(fts: Row[], vec: Row[], limit: number): Passage[] {
  const norm = (rows: Row[]) => {
    const max = Math.max(...rows.map((r) => r.score), 0);
    return max > 0 ? rows.map((r) => ({ r, s: r.score / max })) : [];
  };

  const acc = new Map<string, { row: Row; fts: number; vec: number }>();
  const key = (r: Row) => `${r.memory_id}:${r.seq}`;

  for (const { r, s } of norm(fts)) {
    acc.set(key(r), { row: r, fts: s, vec: 0 });
  }
  for (const { r, s } of norm(vec)) {
    const prev = acc.get(key(r));
    if (prev) prev.vec = s;
    else acc.set(key(r), { row: r, fts: 0, vec: s });
  }

  return [...acc.values()]
    .map(({ row, fts: f, vec: v }) => ({
      memoryId: row.memory_id,
      shortId: row.memory_id.replace(/-/g, '').slice(0, 8),
      title: row.title,
      occurredAt: row.occurred_at,
      capturedAt: row.captured_at,
      domainLabel: row.domain_label,
      mediaType: row.media_type,
      content: row.content,
      seq: row.seq,
      via: (f > 0 && v > 0 ? 'both' : f > 0 ? 'text' : 'semantic') as Passage['via'],
      score: f * W_FTS + v * W_VEC,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
