import type { MemoryDetail, MemorySummary } from '../../core/domain/types';
import type { ReviewItem } from '../../core/ops/review';
import type { Answer } from '../../core/recall/answer';
import { conflicting, contextOf, renderValue, warningFor } from '../../core/facts/format';
import type { FactHit } from '../../core/facts/query';
import type { Result } from '../../core/result';
import { meaningfulName } from '../../core/filenames';

/**
 * El único lugar del proyecto donde vive la prosa. El core no sabe que existe:
 * devuelve datos y este archivo decide cómo se ven.
 */
const KB = 1024;
export const humanSize = (bytes: number | null): string => {
  if (bytes === null) return '—';
  if (bytes < KB) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / KB;
  let i = 0;
  while (v >= KB && i < units.length - 1) { v /= KB; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

export const humanDate = (d: Date | null): string =>
  d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';

const KINDS: [string, string][] = [
  ['application/pdf', 'PDF'], ['image/', 'foto'], ['audio/', 'audio'],
  ['video/', 'video'], ['text/', 'texto'],
];

const kindOf = (mediaType: string | null): string => {
  const hit = KINDS.find(([prefix]) => mediaType?.startsWith(prefix));
  return hit ? hit[1] : 'file';
};

/**
 * Un nombre de cámara o de WhatsApp no es un título: antes de caer en él se
 * prefiere el contenido. Y si tampoco hay, se dice qué es en vez de mentir.
 */
const label = (m: MemorySummary): string =>
  m.title ?? meaningfulName(m.originalFilename) ?? m.excerpt ?? `(${kindOf(m.mediaType)} sin nombre)`;

export function renderList(items: MemorySummary[]): string {
  if (items.length === 0) return 'Nada guardado todavía.';
  return items
    .map((m) => {
      const flags = m.hidden ? ' [oculta]' : '';
      const size = m.sizeBytes === null ? '' : `  ${humanSize(m.sizeBytes)}`;
      return `${m.shortId}  ${humanDate(m.capturedAt)}  ${label(m)}${size}${flags}`;
    })
    .join('\n');
}

/** Cómo se leyó el archivo. Sale en dm show porque explica qué esperar del texto. */
const LANE_LABEL: Record<string, string> = {
  text: 'leído tal cual',
  document: 'markitdown',
  vision: 'transcrito de la imagen',
  audio: 'transcrito del audio',
  none: 'sin carril',
};

export function renderDetail(m: MemoryDetail): string {
  const lines = [
    `id         ${m.id}`,
    `capturada  ${humanDate(m.capturedAt)}`,
    `ocurrió    ${humanDate(m.occurredAt)}`,
    `origen     ${m.source}`,
    `estado     ${m.status}${m.hidden ? ' · oculta' : ''}`,
  ];
  if (m.title) lines.push(`título     ${m.title}`);
  if (m.originalFilename) lines.push(`archivo    ${m.originalFilename}`);
  if (m.mediaType) lines.push(`tipo       ${m.mediaType}  ${humanSize(m.sizeBytes)}`);
  if (m.sha256) lines.push(`sha256     ${m.sha256}`);

  if (m.lane) {
    const how = LANE_LABEL[m.lane] ?? m.lane;
    lines.push(`carril     ${m.lane} · ${how}  ${humanDate(m.normalizedAt)}`);
  } else if (m.sha256) {
    lines.push('carril     todavía sin normalizar — corre dm worker');
  }

  // El error va antes del texto y no después: si lo que sigue está incompleto,
  // enterarse al final es enterarse tarde.
  if (m.normalizationError) lines.push(`⚠ carril    ${m.normalizationError}`);

  // Las dos fuentes se muestran separadas y etiquetadas. Mezclarlas dejaría a
  // la persona sin saber qué escribió ella y qué leyó una máquina de un papel —
  // que es exactamente la diferencia entre un dato y una suposición.
  if (m.note) lines.push('', 'tu nota:', m.note);
  if (m.normalizedText) lines.push('', 'del archivo:', m.normalizedText);
  return lines.join('\n');
}

/**
 * La bandeja de revisión.
 *
 * Lo que importa acá no es la lista: es que cada línea diga **qué hacer**. Una
 * bandeja que enumera problemas sin decir cuál se arregla reintentando y cuál
 * necesita otra cosa te deja igual que antes, mirando psql.
 */
export function renderReview(items: ReviewItem[]): string {
  if (items.length === 0) return 'Nada que revisar.';

  const lines = items.map((m) => {
    const que = m.title ?? meaningfulName(m.originalFilename) ?? `(${kindOf(m.mediaType)} sin nombre)`;
    const salvado = m.chars > 0 ? `  · quedaron ${m.chars} caracteres` : '  · sin texto';
    const accion =
      m.retryable === true ? 'reintentar sirve  → dm reprocess ' + m.shortId
      : m.retryable === false ? 'reintentar NO sirve: necesita otro carril o convertir el archivo'
      : 'no se sabe si sirve reintentar (falló antes de que el sistema distinguiera)';
    return [
      `${m.shortId}  ${humanDate(m.capturedAt)}  ${que}${salvado}`,
      `           ${m.error}`,
      `           ${accion}`,
    ].join('\n');
  });

  const retryable = items.filter((m) => m.retryable === true).length;
  const unclassified = items.filter((m) => m.retryable === null).length;

  // Decir "ninguna se arregla reintentando" cuando en realidad no se sabe sería
  // exactamente la clase de afirmación falsa que esta bandeja existe para
  // evitar. Sin dato, se dice que no hay dato.
  const cola =
    retryable > 0
      ? `\n\n${retryable} de ${items.length} se pueden reintentar: dm reprocess --failed`
      : unclassified === items.length
        ? '\n\nTodavía no sé cuáles se arreglan reintentando; corre dm reprocess --failed --yes una vez y lo sabré.'
        : unclassified > 0
          ? `\n\nNinguna de las clasificadas se arregla reintentando (${unclassified} sin clasificar).`
          : '\n\nNinguna se arregla reintentando.';

  return lines.join('\n\n') + cola;
}

/**
 * Una respuesta con sus fuentes.
 *
 * Las fuentes NO son opcionales ni decorativas: la regla dura 1 dice que ningún
 * dato factual se responde sin memoria de respaldo, así que se muestran siempre
 * —incluso cuando no hubo prosa— y cada una trae su id para poder abrirla.
 */
export function renderAnswer(a: Answer): string {
  // Modo hecho (§6): el dato exacto, no una lista de documentos donde buscarlo.
  if (a.facts?.length) return renderFacts(a.facts);

  const fuentes = a.sources.map((p) => {
    const cuando = (p.occurredAt ?? p.capturedAt).toISOString().slice(0, 10);
    const donde = p.domainLabel ? ` · ${p.domainLabel}` : '';
    const frag = p.content.replace(/\s+/g, ' ').trim();
    return `  ${p.shortId}  ${cuando}${donde}  ${p.title ?? '(sin título)'}\n` +
           `      ${frag.length > 160 ? frag.slice(0, 159) + '…' : frag}`;
  });

  if (a.text) return `${a.text}\n\nfuentes:\n${fuentes.join('\n')}`;

  switch (a.reason) {
    case 'no_results':
      return 'No lo tengo.';
    case 'no_citation':
      // Se descartó la prosa a propósito: una respuesta sin cita no cumple la
      // regla dura 1. Mejor los pasajes crudos que una afirmación sin respaldo.
      return `No pude responderlo sin inventar, pero esto es lo que encontré:\n${fuentes.join('\n')}`;
    case 'ungrounded':
      // Había prosa y se descartó: afirmaba una cifra que no está en lo que
      // leyó. Un número inventado con cita válida es el peor fallo posible acá,
      // porque nada lo delata (regla dura 2).
      return `No pude darte la cifra sin inventarla. Esto es lo que encontré:\n${fuentes.join('\n')}`;
    case 'no_model':
      return `Sin modelo para redactar. Lo que encontré:\n${fuentes.join('\n')}`;
    default:
      return fuentes.join('\n');
  }
}

/**
 * Los datos duros que respondieron.
 *
 * **La advertencia va antes del valor** (regla dura 10). Leer "3 UF" y recién
 * después "vencida en 2024" es exactamente el modo de falla que §1.3 describe:
 * el riesgo no es olvidar un dato, es leer el viejo sin darte cuenta.
 */
function renderFacts(hits: FactHit[]): string {
  const lineas = hits.map((h) => {
    const aviso = warningFor(h);
    const cabeza = aviso ? `⚠ ${aviso}. ` : '';
    return [
      `${cabeza}${h.ref.field.label}: ${renderValue(h.value, h.ref.field.kind)}`,
      `    ${contextOf(h)} · ${h.fact.shortId}`,
    ].join('\n');
  });
  // Regla dura 3: dos vigentes del mismo dato no se resuelven eligiendo uno.
  const conflicto = conflicting(hits)
    ? '\n\nHay dos vigentes que dicen cosas distintas. No elijo por ti.'
    : '';
  return lineas.join('\n') + conflicto;
}

/** Errores y confirmaciones: qué pasó y qué hacer, sin disculpas ni vaguedad. */
export function renderFailure(result: Extract<Result<unknown>, { ok: false }>): string {
  if (result.kind === 'requires_confirmation') {
    const affected = result.affects.map((a) => `  · ${a.label ?? a.id}`).join('\n');
    return `${result.message}\n${affected}\n\nRepite con --yes si es lo que quieres.`;
  }
  const detail = result.detail as { matches?: string[] } | undefined;
  if (result.kind === 'ambiguous' && detail?.matches) {
    return `${result.message}\n${detail.matches.map((m) => `  · ${m}`).join('\n')}`;
  }
  return result.message;
}
