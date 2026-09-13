/**
 * What the core returns, as the client sees it.
 *
 * Written by hand and not generated, because generating them would tie the web's
 * build to the app's — and the whole point of two processes is that neither
 * needs the other to build. The cost is that these can drift; the API tests are
 * what catch that, since they assert on the same shapes.
 */

export interface MemorySummary {
  id: string;
  shortId: string;
  title: string | null;
  source: string;
  capturedAt: string;
  occurredAt: string | null;
  originalFilename: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  domainLabel: string | null;
  status: string;
  hidden: boolean;
  excerpt: string | null;
  tags: string[];
}

export interface MemoryDetail extends MemorySummary {
  note: string | null;
  normalizedText: string | null;
  normalizationLane: string | null;
  sha256: string | null;
  domainConfidence: number | null;
}

export interface Fact {
  id: string;
  memoryId: string;
  typeSlug: string;
  typeLabel: string;
  kind: 'state' | 'period';
  payload: Record<string, string | number>;
  identity: string | null;
  validFrom: string | null;
  validUntil: string | null;
  supersededBy: string | null;
  shortId: string;
  memoryTitle: string | null;
}

export interface Domain {
  id: string;
  slug: string;
  label: string;
  description: string;
  aliases: string[];
  active: boolean;
  count?: number;
}

export interface FactType {
  id: string;
  slug: string;
  label: string;
  description: string;
  kind: 'state' | 'period';
  domainSlug: string | null;
  fields: { name: string; kind: string; label: string; aliases: string[] }[];
  identityField: string | null;
  active: boolean;
}

export interface FieldProposal {
  name: string;
  kind: string;
  label: string;
  aliases: string[];
  example: string;
}

export interface TypeProposal {
  slug: string;
  label: string;
  description: string;
  kind: 'state' | 'period';
  domainSlug: string;
  fields: FieldProposal[];
  identityField: string | null;
  validFromField: string | null;
  validUntilField: string | null;
  fromShortId: string;
  fromTitle: string | null;
  discarded: string[];
}

export interface SessionInfo {
  authenticated: boolean;
  ownerId?: string;
  sessions?: {
    id: string;
    createdAt: string;
    expiresAt: string;
    lastSeenAt: string | null;
    userAgent: string | null;
  }[];
}

export interface BackupConfig {
  repository: string;
  transport: string;
  transportConfig: Record<string, unknown>;
  mirrorPath: string | null;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastVerifiedAt: string | null;
}

export interface Overview {
  domains: Domain[];
  pendingReview: { pending: number; needsReview: number } | number;
  facts: number;
  backup: BackupConfig | null;
}

export interface ReviewItem extends MemorySummary {
  reason?: string;
}
