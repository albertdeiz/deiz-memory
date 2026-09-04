/**
 * The lane router. Pure logic on purpose: which tool to use is a product rule,
 * not an adapter detail, so it has to be testable without Docker, without a
 * network and without spending a cent on tokens.
 *
 * The caveat that shapes all of it: **the document converter does no OCR**. A
 * scanned PDF comes back empty and a photo comes back, at best, as a
 * description. So there is no single "normalize call": there are lanes and a
 * fallback rule between them.
 */
import type { Lane } from '../domain/types';

export type { Lane };

export const LANES: readonly Lane[] = ['text', 'document', 'vision', 'audio', 'none'];

/**
 * Below this we assume the PDF had no text layer and the right move is to look
 * at the paper instead.
 */
export const POOR_TEXT_CHARS = 100;

/**
 * Postgres full-text indexing breaks past roughly a megabyte. A 600-page PDF
 * gets there without trying, so the text is clamped before storing and the
 * clamp is noted in the text itself — the original blob stays intact and can
 * always be reprocessed.
 */
export const MAX_NORMALIZED_CHARS = 500_000;

const OOXML = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

/**
 * The lanes to try, in order. The first is preferred; the rest are the net
 * underneath, and they get used for two different reasons:
 *
 *   - the preferred lane is not configured at all
 *   - the preferred lane ran and returned garbage (the scanned PDF)
 *
 * An empty array is not an error: it is a format there is honestly nothing to
 * extract from. The blob is stored either way.
 */
export function lanesFor(mediaType: string | null): Lane[] {
  if (!mediaType) return [];

  // Already text: reading it IS the conversion. Cheap, deterministic, no deps.
  if (mediaType === 'text/plain' || mediaType === 'text/markdown') return ['text'];

  // The document lane preserves structure — a table still looks like a table —
  // which is better input than flattening it. But if it is missing, these are
  // still text: reading them raw is worse and works.
  if (mediaType === 'text/html' || mediaType === 'text/csv' || mediaType === 'application/json') {
    return ['document', 'text'];
  }

  // The case that justifies the whole machine: out through the document lane if
  // it has a text layer, out through the visual one if it is a scan.
  if (mediaType === 'application/pdf') return ['document', 'vision'];

  if (OOXML.includes(mediaType)) return ['document'];

  // The document lane on an image yields a *description*, and a description is
  // not a transcript: for a handwritten prescription it is worth nothing.
  if (mediaType.startsWith('image/')) return ['vision'];

  if (mediaType.startsWith('audio/')) return ['audio'];

  // Video is stored, not transcribed. Pulling the audio track is another job,
  // and pretending otherwise would be worse than saying so.
  return [];
}

/** Little text and no structure: what a PDF with no text layer returns. */
export const isPoor = (text: string | null | undefined): boolean =>
  (text ?? '').trim().length < POOR_TEXT_CHARS;

/**
 * Normalize to NFKC before storing.
 *
 * Not cosmetic. An OCR engine can return full-width characters — `INMOBＩLＩＡRＩＡ`
 * with U+FF29 instead of `I` — and Postgres `unaccent` does not touch them, so
 * that document stops appearing when you search for the plain word. It happened
 * for real, on a scanned building plan.
 *
 * NFKC also fixes ligatures (`ﬁ` to `fi`) and superscripts, which fail the same
 * way. Applied to everything derived and to no original: the blob is untouched,
 * and this text is regenerated whenever needed.
 */
export const canonical = (text: string): string => text.normalize('NFKC');

/** Clamp to the index limit, saying so inside the text itself. */
export function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_NORMALIZED_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_NORMALIZED_CHARS) + '\n\n[texto recortado para indexar; el original está completo]',
    truncated: true,
  };
}
