import type { Actor } from '../domain/types';
import { activeDomains, createDomain, slugify, type Domain } from '../ops/domains';
import type { Deps } from '../ports';
import { ok, type Result } from '../result';

/**
 * Dominios emergentes (§9).
 *
 * El punto de esto no es ahorrar tipeo: es que **no tienes que anticipar tus
 * propias categorías**. Hoy no sabes qué vas a necesitar guardar en dos años, y
 * el sistema puede descubrirlo mirando lo que ya no calza en ningún lado.
 *
 * Con una regla dura encima: **el bot propone, nunca crea solo** (§9). Una
 * propuesta es una pregunta, y la respuesta es tuya.
 */

/** Cuántas memorias sueltas hacen un racimo. §9 usa tres como ejemplo. */
export const MIN_CLUSTER = 3;

/** Palabras que aparecen en todo y no distinguen nada. */
const STOP = new Set([
  'imagen', 'foto', 'fotografia', 'documento', 'archivo', 'pdf', 'png', 'jpg',
  'escaneo', 'captura', 'personal', 'copia', 'nota', 'texto', 'prueba', 'test',
  'digital', 'nuevo', 'nueva', 'para', 'con', 'del', 'los', 'las', 'una', 'por',
]);

export interface Proposal {
  /** La etiqueta que comparten, y que da nombre a la categoría propuesta. */
  keyword: string;
  label: string;
  slug: string;
  /** Descripción sugerida, armada con lo que de verdad comparten. */
  description: string;
  memoryIds: string[];
  /** Títulos de ejemplo, para que puedas decidir mirando y no a ciegas. */
  examples: string[];
}

interface Row {
  id: string;
  title: string | null;
  tags: string[] | null;
}

/**
 * Busca racimos entre lo que quedó sin dominio.
 *
 * Usa las etiquetas que ya puso el clasificador, no una segunda pasada del
 * modelo. Es más barato, es determinista, y sobre todo: si el modelo ya
 * etiquetó diez cosas como "webdox", ese acuerdo entre diez documentos es mejor
 * señal que preguntarle otra vez.
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

  // Una etiqueta → las memorias que la comparten.
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

  // Una memoria pertenece a un solo racimo: al más grande que la contenga. Sin
  // esto, "webdox" y "corporativo" propondrían dos categorías para las mismas
  // diez cosas, que es justo la proliferación que §9 quiere evitar.
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
 * Arma una descripción con las palabras que el racimo comparte de verdad.
 *
 * Sirve como punto de partida, no como respuesta final: §9 dice que la
 * descripción es el prompt del clasificador, así que conviene revisarla antes
 * de aceptarla. Por eso la propuesta la muestra en vez de aplicarla callada.
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

/** Palabras que ya viven en la descripción de un dominio activo. */
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
 * Acepta una propuesta: crea el dominio y mueve las memorias del racimo.
 *
 * Existe como operación aparte y no dentro de `proposeDomains` porque esa
 * separación **es** la regla: proponer no cambia nada, y solo esto —que exige
 * una decisión tuya— escribe.
 */
export async function acceptProposal(
  deps: Deps,
  actor: Actor,
  p: { label: string; description: string; memoryIds: string[] },
): Promise<Result<AcceptResult>> {
  // `confirm: true`: el chequeo de solapamiento ya corrió al proponer, porque
  // se descartaron las palabras que viven en un dominio activo.
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

/** Para que el chat pueda decir "hay algo que proponerte" sin traerse todo. */
export async function hasProposals(deps: Deps, actor: Actor): Promise<number> {
  const r = await proposeDomains(deps, actor);
  return r.ok ? r.value.length : 0;
}
