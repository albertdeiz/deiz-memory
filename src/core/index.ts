export * from './result';
export * from './domain/types';
export * from './ports';
export * from './media';
export * from './filenames';
export { capture, type CaptureInput, type CaptureResult } from './ops/capture';
export { list, search, show, fetchBlob, type ListInput, type SearchInput, type BlobPayload } from './ops/query';
export { setHidden, purge, type HideResult, type PurgeResult } from './ops/lifecycle';
export { listOwners, createOwner, resolveActor } from './ops/owners';
export {
  mintPairingCode, redeemPairingCode, identityOwner, touchIdentity, listIdentities,
  PAIRING_TTL_MS, type PairingCode, type Identity, type LinkedIdentity,
} from './ops/identity';
export { resolveMemoryId } from './ops/resolve';
export { reprocess, type ReprocessInput, type ReprocessResult } from './ops/reprocess';
export {
  listDomains, activeDomains, findDomain, createDomain, editDomain,
  archiveDomain, mergeDomains, seedDomains, slugify, SEED_DOMAINS,
  type Domain, type CreateDomainInput, type MergeResult,
} from './ops/domains';
export {
  listReview, countReview, type ReviewItem, type ReviewInput, type ReviewCounts,
} from './ops/review';
export {
  proposeDomains, acceptProposal, hasProposals, MIN_CLUSTER,
  type Proposal, type AcceptResult,
} from './classify/emergent';
export { chunkText, contextualize, TARGET_CHARS } from './recall/chunk';
export { indexMemory, pendingIndex, unindexed, type IndexOutcome } from './recall/index-chunks';
export { retrieve, type Passage, type RetrieveInput } from './recall/retrieve';
export { answer, type Answer, type AnswerInput } from './recall/answer';
export { classifyMemory, LOW_CONFIDENCE, type ClassifyOutcome } from './classify/run';
export { buildPrompt, validate, classifySchema, type Classification } from './classify/prompt';
export { normalizeMemory, type NormalizeOutcome, type Attempt } from './normalize/run';
export { lanesFor, isPoor, clamp, POOR_TEXT_CHARS, MAX_NORMALIZED_CHARS, LANES } from './normalize/lanes';
export { storageKey } from './ops/rows';
export {
  exportOwner, checkExport, importInto, readBackupConfig, setBackupDestination,
  recordBackupRun, recordBackupVerified, secretsNeededBy,
  BACKED_UP_TABLES, NOT_BACKED_UP, TRANSPORTS,
  type BackupSink, type BackupSource, type BackupManifest, type BackupConfig,
  type CheckReport, type Row, type Transport, type Destination, type WebdavConfig,
} from './ops/backup';

// Datos tipados (§4). El modo hecho de §6.
export { extractFacts, type ExtractOutcome } from './facts/extract';
export { listFacts, factsForMemory, askFacts, matchFields, type FactHit } from './facts/query';
export {
  listFactTypes, findFactType, typesForDomain, seedFactTypes, SEED_FACT_TYPES,
} from './facts/registry';
export { conflicting, contextOf, renderValue, warningFor } from './facts/format';
export type { Fact, FactType, FactField, FactKind, FieldKind } from './facts/types';
