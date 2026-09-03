import type { Lane, MemoryDetail, MemorySummary, Source, Status } from '../domain/types.js';
import { excerptOf, shortId } from '../domain/types.js';

export const MEMORY_COLUMNS = `
  m.id, m.owner_id, m.source, m.captured_at, m.occurred_at,
  m.original_filename, m.title, m.note, m.normalized_text, m.status, m.hidden,
  m.normalization_lane, m.normalized_at, m.normalization_error,
  m.blob_sha256, m.domain_id, m.tags, m.domain_confidence, b.media_type, b.size_bytes`;

export const MEMORY_FROM = `from memories m left join blobs b on b.sha256 = m.blob_sha256`;

export interface MemoryRow {
  id: string;
  owner_id: string;
  source: string;
  captured_at: Date;
  occurred_at: Date | null;
  original_filename: string | null;
  title: string | null;
  note: string | null;
  normalized_text: string | null;
  normalization_lane: string | null;
  normalized_at: Date | null;
  normalization_error: string | null;
  status: string;
  hidden: boolean;
  blob_sha256: string | null;
  domain_id: string | null;
  tags: string[] | null;
  domain_confidence: number | null;
  media_type: string | null;
  size_bytes: string | number | null;
}

export const toSummary = (r: MemoryRow): MemorySummary => ({
  id: r.id,
  shortId: shortId(r.id),
  title: r.title,
  source: r.source as Source,
  capturedAt: r.captured_at,
  occurredAt: r.occurred_at,
  originalFilename: r.original_filename,
  mediaType: r.media_type,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  hidden: r.hidden,
  // Tus palabras antes que las de la máquina: si escribiste una nota al mandar
  // la foto, eso es lo que reconoces en una lista, no el OCR del papel.
  excerpt: excerptOf(r.note ?? r.normalized_text),
  domainId: r.domain_id,
  tags: r.tags ?? [],
});

export const toDetail = (r: MemoryRow): MemoryDetail => ({
  ...toSummary(r),
  ownerId: r.owner_id,
  status: r.status as Status,
  sha256: r.blob_sha256,
  note: r.note,
  normalizedText: r.normalized_text,
  lane: r.normalization_lane as Lane | null,
  normalizedAt: r.normalized_at,
  normalizationError: r.normalization_error,
});

export const storageKey = (sha256: string): string =>
  `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
