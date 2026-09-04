export * from './result.js';
export * from './domain/types.js';
export * from './ports.js';
export * from './media.js';
export * from './filenames.js';
export { capture, type CaptureInput, type CaptureResult } from './ops/capture.js';
export { list, search, show, fetchBlob, type ListInput, type SearchInput, type BlobPayload } from './ops/query.js';
export { setHidden, purge, type HideResult, type PurgeResult } from './ops/lifecycle.js';
export { listOwners, createOwner, resolveActor } from './ops/owners.js';
export {
  mintPairingCode, redeemPairingCode, identityOwner, touchIdentity, listIdentities,
  PAIRING_TTL_MS, type PairingCode, type Identity, type LinkedIdentity,
} from './ops/identity.js';
export { resolveMemoryId } from './ops/resolve.js';
export { reprocess, type ReprocessInput, type ReprocessResult } from './ops/reprocess.js';
export {
  listDomains, activeDomains, findDomain, createDomain, editDomain,
  archiveDomain, mergeDomains, seedDomains, slugify, SEED_DOMAINS,
  type Domain, type CreateDomainInput, type MergeResult,
} from './ops/domains.js';
export {
  listReview, countReview, type ReviewItem, type ReviewInput, type ReviewCounts,
} from './ops/review.js';
export {
  proposeDomains, acceptProposal, hasProposals, MIN_CLUSTER,
  type Proposal, type AcceptResult,
} from './classify/emergent.js';
export { chunkText, contextualize, TARGET_CHARS } from './recall/chunk.js';
export { indexMemory, pendingIndex, unindexed, type IndexOutcome } from './recall/index-chunks.js';
export { retrieve, type Passage, type RetrieveInput } from './recall/retrieve.js';
export { answer, type Answer, type AnswerInput } from './recall/answer.js';
export { classifyMemory, LOW_CONFIDENCE, type ClassifyOutcome } from './classify/run.js';
export { buildPrompt, validate, classifySchema, type Classification } from './classify/prompt.js';
export { normalizeMemory, type NormalizeOutcome, type Attempt } from './normalize/run.js';
export { lanesFor, isPoor, clamp, POOR_TEXT_CHARS, MAX_NORMALIZED_CHARS, LANES } from './normalize/lanes.js';
export { storageKey } from './ops/rows.js';

// Datos tipados (§4). El modo hecho de §6.
export { extractFacts, type ExtractOutcome } from './facts/extract.js';
export { listFacts, factsForMemory, askFacts, matchFields, type FactHit } from './facts/query.js';
export {
  listFactTypes, findFactType, typesForDomain, seedFactTypes, SEED_FACT_TYPES,
} from './facts/registry.js';
export { conflicting, contextOf, renderValue, warningFor } from './facts/format.js';
export type { Fact, FactType, FactField, FactKind, FieldKind } from './facts/types.js';
