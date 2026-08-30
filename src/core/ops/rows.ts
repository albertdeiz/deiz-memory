import type { MemoryDetail, MemorySummary, Source, Status } from '../domain/types.js';
import { excerptOf, shortId } from '../domain/types.js';

export const MEMORY_COLUMNS = `
  m.id, m.owner_id, m.parent_id, m.source, m.captured_at, m.occurred_at,
  m.original_filename, m.title, m.normalized_text, m.status, m.hidden,
  m.blob_sha256, b.media_type, b.size_bytes`;

export const MEMORY_FROM = `from memories m left join blobs b on b.sha256 = m.blob_sha256`;

export interface MemoryRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  source: string;
  captured_at: Date;
  occurred_at: Date | null;
  original_filename: string | null;
  title: string | null;
  normalized_text: string | null;
  status: string;
  hidden: boolean;
  blob_sha256: string | null;
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
  excerpt: excerptOf(r.normalized_text),
});

export const toDetail = (r: MemoryRow): MemoryDetail => ({
  ...toSummary(r),
  ownerId: r.owner_id,
  parentId: r.parent_id,
  status: r.status as Status,
  sha256: r.blob_sha256,
  normalizedText: r.normalized_text,
});

export const storageKey = (sha256: string): string =>
  `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
