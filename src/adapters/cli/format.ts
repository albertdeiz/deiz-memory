import type { MemoryDetail, MemorySummary } from '../../core/domain/types.js';
import type { Result } from '../../core/result.js';
import { meaningfulName } from '../../core/filenames.js';

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
  return hit ? hit[1] : 'archivo';
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
  if (m.normalizedText) lines.push('', m.normalizedText);
  return lines.join('\n');
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
