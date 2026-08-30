export type Uuid = string;

export type Source = 'cli' | 'telegram' | 'email' | 'manual';
export type Status = 'raw' | 'normalized' | 'classified' | 'needs_review' | 'verified';

export const SOURCES: readonly Source[] = ['cli', 'telegram', 'email', 'manual'];

/** Quién ejecuta la operación. Va en TODA llamada al core (regla dura 9). */
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
  /** Los uuid son ilegibles en terminal: se muestra y se acepta el prefijo, como git. */
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
}

export interface MemoryDetail extends MemorySummary {
  ownerId: Uuid;
  parentId: Uuid | null;
  status: Status;
  sha256: string | null;
  /** Lo que escribió la persona. No se regenera nunca. */
  note: string | null;
  /** Lo que se extrajo del archivo. Regenerable desde el original (UC-15). */
  normalizedText: string | null;
  lane: Lane | null;
  normalizedAt: Date | null;
  normalizationError: string | null;
}

export const shortId = (id: Uuid): string => id.replace(/-/g, '').slice(0, 8);

/** Primeros N caracteres de texto, con los espacios colapsados. */
export const excerptOf = (text: string | null, max = 160): string | null => {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
};
