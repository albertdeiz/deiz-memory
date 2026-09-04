import type { Actor } from '../domain/types';
import { activeDomains, createDomain, slugify, type Domain } from '../ops/domains';
import type { Deps } from '../ports';
import { ok, type Result } from '../result';

/**
 * Dominios emergentes (§9).
 *
 * The point is not saving typing: it is that **you do not have to anticipate
 * your own categories**. You do not know today what you will need to store in
 * two years, and the system can discover it from what fits nowhere.
 *
 * With one hard rule on top: **the bot proposes, it never creates on its own.**
 * propuesta es una pregunta, y la respuesta es tuya.
 */

/** How many loose memories make a cluster. */
export const MIN_CLUSTER = 3;

/** Words that appear in everything and distinguish nothing. */
const STOP = new Set([
  'imagen', 'foto', 'fotografia', 'documento', 'archivo', 'pdf', 'png', 'jpg',
  'escaneo', 'captura', 'personal', 'copia', 'nota', 'texto', 'prueba', 'test',
  'digital', 'nuevo', 'nueva', 'para', 'con', 'del', 'los', 'las', 'una', 'por',
]);

export interface Proposal {
  /** The tag they share, which names the proposed category. */
  keyword: string;
  label: string;
  slug: string;
  /** Suggested description, built from what they actually share. */
  description: string;
  memoryIds: string[];
  /** Sample titles, so you can decide by looking rather than blindly. */
  examples: string[];
}

interface Row {
  id: string;
  title: string | null;
  tags: string[] | null;
}

/**
 * Looks for clusters among whatever was left uncategorized.
 *
 * It uses the tags the classifier already assigned, not a second pass of the
 * model. Cheaper, deterministic, and above all: if the model already tagged ten
 * things the same way, that agreement across ten documents is better signal
 * than asking it again.
 */
export async function proposeDomains(
  deps: Deps,
  actor: Actor,
  opts: { minCluster?: number } = {},
): Promise<Result<Proposal[]>> {
  const min = Math.max(opts.minCluster ?? MIN_CLUSTER, 2);

  const { rows } = await deps.db.query<Row>(
    `select id, title, tags from memories
      where owner_id = $1 and domain_id is null and not hidden
        and cardinality(tags) > 0`,
    [actor.ownerId],
  );
  if (rows.length < min) return ok([]);

  const existentes = await activeDomains(deps.db, actor);
  const yaCubierto = coveredWords(existentes);

  // One tag to the memories that share it.
  const porEtiqueta = new Map<string, Row[]>();
  for (const r of rows) {
    for (const t of new Set((r.tags ?? []).map(normalize))) {
      if (!usable(t, yaCubierto)) continue;
      const lista = porEtiqueta.get(t) ?? [];
      lista.push(r);
      porEtiqueta.set(t, lista);
    }
  }

  const racimos = [...porEtiqueta.entries()]
    .filter(([, ms]) => ms.length >= min)
    .sort((a, b) => b[1].length - a[1].length);

  // A memory belongs to exactly one cluster: the largest that contains it. Without
  // this, two overlapping tags would propose two categories for the same
  // ten things, which is precisely the proliferation to avoid.
  const tomadas = new Set<string>();
  const propuestas: Proposal[] = [];

  for (const [keyword, memorias] of racimos) {
    const libres = memorias.filter((m) => !tomadas.has(m.id));
    if (libres.length < min) continue;
    for (const m of libres) tomadas.add(m.id);

    const label = keyword.charAt(0).toUpperCase() + keyword.slice(1);
    propuestas.push({
      keyword,
      label,
      slug: slugify(label),
      description: describe(keyword, libres),
      memoryIds: libres.map((m) => m.id),
      examples: libres.map((m) => m.title).filter((t): t is string => !!t).slice(0, 3),
    });
  }

  return ok(propuestas);
}

/**
 * Builds a description from the words the cluster genuinely shares.
 *
 * A starting point, not a final answer: the description IS the classifier's
 * prompt, so it is worth reviewing before accepting. Which is why the proposal
 * shows it instead of applying it quietly.
 */
function describe(keyword: string, memorias: Row[]): string {
  const frecuencia = new Map<string, number>();
  for (const m of memorias) {
    for (const t of new Set((m.tags ?? []).map(normalize))) {
      if (t === keyword || !usable(t, new Set())) continue;
      frecuencia.set(t, (frecuencia.get(t) ?? 0) + 1);
    }
  }
  const acompañantes = [...frecuencia.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t]) => t);

  return acompañantes.length
    ? `${keyword}: ${acompañantes.join(', ')}`
    : `Cosas relacionadas con ${keyword}`;
}

const normalize = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const usable = (t: string, yaCubierto: Set<string>): boolean =>
  t.length > 3 && !STOP.has(t) && !yaCubierto.has(t) && !/^\d+$/.test(t);

/** Words that already live in an active domain's description. */
function coveredWords(domains: Domain[]): Set<string> {
  const out = new Set<string>();
  for (const d of domains) {
    out.add(normalize(d.slug));
    out.add(normalize(d.label));
    for (const w of normalize(d.description).split(/[^a-z0-9]+/)) {
      if (w.length > 3) out.add(w);
    }
  }
  return out;
}

export interface AcceptResult {
  domain: Domain;
  moved: number;
}

/**
 * Accepts a proposal: creates the domain and moves the cluster's memories.
 *
 * A separate operation and not part of proposing, because that separation **is**
 * the rule: proposing changes nothing, and only this — which requires a decision
 * from you — writes.
 */
export async function acceptProposal(
  deps: Deps,
  actor: Actor,
  p: { label: string; description: string; memoryIds: string[] },
): Promise<Result<AcceptResult>> {
  // Confirmation is implied: the overlap check already ran while proposing,
  // since words living in an active domain were discarded there.
  const creado = await createDomain(deps.db, actor, {
    label: p.label,
    description: p.description,
    confirm: true,
  });
  if (!creado.ok) return creado;

  if (p.memoryIds.length === 0) return ok({ domain: creado.value, moved: 0 });

  const { rowCount } = await deps.db.query(
    `update memories set domain_id = $3, updated_at = now()
      where owner_id = $1 and id = any($2::uuid[]) and domain_id is null`,
    [actor.ownerId, p.memoryIds, creado.value.id],
  );
  return ok({ domain: creado.value, moved: rowCount });
}

/** So the chat can say "there is something to propose" without fetching all. */
export async function hasProposals(deps: Deps, actor: Actor): Promise<number> {
  const r = await proposeDomains(deps, actor);
  return r.ok ? r.value.length : 0;
}
