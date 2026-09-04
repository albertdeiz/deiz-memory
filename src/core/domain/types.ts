export type Uuid = string;

export type Source = 'cli' | 'telegram' | 'manual';
export type Status = 'raw' | 'normalized' | 'classified' | 'needs_review' | 'verified';

export const SOURCES: readonly Source[] = ['cli', 'telegram', 'manual'];

/**
 * Who is running the operation. Present in EVERY call into the core.
 *
 * Owner isolation stops depending on someone remembering a `WHERE` clause: with
 * no actor there is no way to reach an operation at all.
 */
export interface Actor {
  ownerId: Uuid;
}

export interface Owner {
  id: Uuid;
  label: string;
  createdAt: Date;
}

export type Lane = 'text' | 'document' | 'vision' | 'audio' | 'none';

export interface MemorySummary {
  id: Uuid;
  /** Uuids are unreadable in a terminal: the prefix is shown and accepted, like git. */
  shortId: string;
  title: string | null;
  source: Source;
  capturedAt: Date;
  occurredAt: Date | null;
  originalFilename: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  hidden: boolean;
  excerpt: string | null;
  domainId: Uuid | null;
  /** Carried so rendering never has to resolve the id. */
  domainLabel: string | null;
  tags: string[];
}

export interface MemoryDetail extends MemorySummary {
  ownerId: Uuid;
  status: Status;
  sha256: string | null;
  /** What the person wrote. Never regenerated, never overwritten. */
  note: string | null;
  /** What was read out of the file. Regenerable from the original blob. */
  normalizedText: string | null;
  lane: Lane | null;
  normalizedAt: Date | null;
  normalizationError: string | null;
}

export const shortId = (id: Uuid): string => id.replace(/-/g, '').slice(0, 8);

/** First N characters of text, whitespace collapsed. */
export const excerptOf = (text: string | null, max = 160): string | null => {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
};
