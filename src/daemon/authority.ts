import { decideAutoApply, enableAutoApply, engageKillSwitch, rearmAutoApplyAuthorized } from "../auto-apply.js";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  assertExecutableAdapter,
  compiledAdapterCapabilities,
  resolveEffectiveAdapterCapabilities
} from "../adapters/registry.js";
import { sha256, stableStringify } from "../hash.js";
import type { AuthorityOperation } from "../ipc/protocol.js";
import { createSignedCheckpoint, verifyCheckpointChain } from "../security/audit-checkpoint.js";
import type { CredentialStore } from "../security/credential-store.js";
import { applyLegacyImport, planLegacyImport, summarizeLegacyImportPlan } from "../storage/legacy-import.js";
import type { EncryptedEventStore, StoredEvent } from "../storage/encrypted-event-store.js";
import { RuntimeRepository } from "../storage/runtime-repository.js";
import { createEncryptedBackup, inspectEncryptedBackup } from "../storage/encrypted-backup.js";
import { writeOperationJournal, type StorageOperationJournal } from "../storage/operation-journal.js";
import { CREDENTIAL_ACCOUNTS, getOrCreateCredential } from "../security/credential-store.js";
import { createPublicKey } from "node:crypto";
import type { TrustedApprover } from "../approval.js";
import { PACKAGE_ROOT } from "../paths.js";
import { assertSchema } from "../schema.js";
import { validateDocumentAst, type DocumentAst } from "../document-ast.js";
import { validateDocumentAstV2, type DocumentAstV2 } from "../documents/document-ast-v2.js";
import { ArtifactVault, assertArtifactManifest, type ArtifactManifest } from "../storage/artifact-vault.js";
import {
  PRODUCT_DOMAIN_NAMES,
  ProductRepositories,
  type CampaignRecord,
  type ProductDomainName,
  type VersionedDomainRecord
} from "../storage/product-repositories.js";
import {
  cancelOnboarding,
  completeOnboardingStep,
  createOnboardingSession,
  failOnboarding,
  resumeOnboarding,
  type ActionableOnboardingStep,
  type OnboardingSession,
  type OnboardingStepResultInput,
  type RedactedResultPointer
} from "../onboarding.js";
import {
  assertProfileImportPlan,
  careerTwinFromImportPlan,
  createProfileImportPlan,
  parseProfileArtifact,
  type ProfileImportPlan
} from "../import/profile-import.js";
import { PROFILE_IMPORT_FORMATS, type ProfileImportFormat } from "../import/profile-parser-worker.js";
import { ApplicationTracker } from "../storage/application-tracker.js";
import { DecisionIntelligenceRepositories, type CredentialMappingPlan } from "../storage/decision-intelligence-repositories.js";
import {
  NetworkAccessGrantRepository,
  PersistentGovernedRateGate,
  type StoredNetworkAccessGrantRecord
} from "../storage/network-access-grant-repository.js";
import type { SourceObservation } from "../discovery/source-observation.js";
import type { OpportunityTruthRecord } from "../discovery/opportunity-truth.js";
import type { LivenessAssessment } from "../discovery/liveness.js";
import {
  deduplicateCandidates,
  type DedupeCandidate,
  type DedupeDecision,
  type DedupeResult
} from "../discovery/dedupe.js";
import {
  createDefaultGovernedFetchBroker,
  type GovernedFetchBroker,
  type GovernedRateGate
} from "../discovery/governed-fetch-broker.js";
import {
  createSignedNetworkAccessGrantVerifier,
  verifySignedNetworkAccessGrant,
  type SignedNetworkAccessGrantEnvelope,
  type TrustedNetworkAccessGrantIssuer
} from "../discovery/network-access-grant.js";
import {
  buildOperatorScopedEgressManifest,
  GovernedProviderRuntime
} from "../discovery/provider-runtime.js";
import {
  providerManifestById,
  type DiscoveryProviderId
} from "../discovery/providers.js";
import { deriveDiscoveryPosting } from "../discovery/discovery-records.js";
import { validateTaxonomySnapshot, type TaxonomySnapshot } from "../taxonomy/snapshot.js";
import { rankTaxonomyConcepts, type TaxonomyMappingSet } from "../taxonomy/mapping.js";
import type { CareerAssuranceCase } from "../assurance/index.js";
import {
  createCredentialCryptoVerifier,
  createCredentialPassportExport,
  createLocalCredentialDocumentLoader,
  importCredential,
  type CredentialInputFormat,
  type CredentialPassportEntry
} from "../credentials/index.js";
import type { ApplicationAttemptInput } from "../application-lifecycle.js";
import type { CareerOutcomeEvent } from "../outcome-learning.js";
import type { OpportunityRecord } from "../opportunity.js";
import type { SubmissionProof, TrustedCollector } from "../submission-proof.js";
import type {
  ActionLedgerEntry,
  ApplicationPacket,
  ApprovalReference,
  AutomationRiskSignals,
  AutoApplyDecision,
  ClaimGraph,
  HighStakesFlags,
  ReversibilityTag
} from "../types.js";

interface AuthorityBinding {
  requestId: string;
  requestHash: string;
  operation: AuthorityOperation;
  responseHash: string;
}

interface AuthorityEventPayload {
  authority?: AuthorityBinding;
  metadata?: {
    authority?: AuthorityBinding;
  };
  response?: unknown;
  config?: unknown;
}

const DECISION_INTELLIGENCE_RECORD_OPERATIONS = new Set<AuthorityOperation>([
  "source-observation-record",
  "opportunity-truth-record",
  "liveness-assessment-record",
  "dedupe-result-record",
  "taxonomy-snapshot-record",
  "taxonomy-mapping-record",
  "assurance-case-record",
  "credential-passport-record",
  "credential-mapping-record"
]);

const MAX_INLINE_AUTHORITY_VALUE_BYTES = 512 * 1024;
const MAX_INLINE_AUTHORITY_RESPONSE_BYTES = 768 * 1024;
const MAX_TAXONOMY_ARTIFACT_BYTES = 32 * 1024 * 1024;
const DEFAULT_DECISION_PAGE_LIMIT = 50;
const MAX_DECISION_PAGE_LIMIT = 100;
const MAX_DISCOVERY_POSTINGS_PER_RUN = 500;
const MAX_INCREMENTAL_DEDUPE_CANDIDATES = 1_000;

export interface GovernedDiscoveryBrokerContext {
  readonly grantVerifier: Parameters<typeof createDefaultGovernedFetchBroker>[0];
  readonly rateGate: GovernedRateGate;
}

export interface RuntimeAuthorityOptions {
  readonly createGovernedDiscoveryBroker?: (
    context: GovernedDiscoveryBrokerContext
  ) => GovernedFetchBroker;
}

export interface AuthorityRequest {
  id: string;
  operation: AuthorityOperation;
  payload: unknown;
}

function assertRequestId(requestId: string): void {
  if (!/^REQ-[A-Za-z0-9-]{8,100}$/.test(requestId)) {
    throw new Error("Authority request id is invalid");
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Authority operation payload must be an object");
  }
  return value as Record<string, unknown>;
}

function exactObjectPayload(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  const payload = objectPayload(value);
  const actualKeys = Object.keys(payload).sort();
  const requiredKeys = [...expectedKeys].sort();
  if (stableStringify(actualKeys) !== stableStringify(requiredKeys)) {
    throw new Error(`Authority operation payload must contain exactly: ${requiredKeys.join(", ") || "no fields"}`);
  }
  return payload;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

function assertInlineAuthorityValue(value: unknown): void {
  if (jsonByteLength(value) > MAX_INLINE_AUTHORITY_VALUE_BYTES) {
    throw new Error("Inline authority value exceeds the safe IPC budget. Use an artifact-backed operation");
  }
}

function boundedAuthorityResponse<T>(value: T, label: string): T {
  if (jsonByteLength(value) > MAX_INLINE_AUTHORITY_RESPONSE_BYTES) {
    throw new Error(`${label} exceeds the safe IPC response budget. Use a query or artifact-backed export operation`);
  }
  return value;
}

function discoveryProviderId(value: unknown): DiscoveryProviderId {
  const providerId = requiredString(value, "Discovery provider id");
  return providerManifestById(providerId).providerId as DiscoveryProviderId;
}

function networkGrantSummary(record: StoredNetworkAccessGrantRecord): Record<string, unknown> {
  return {
    grantId: record.grantId,
    grantDigest: record.grantDigest,
    providerId: record.envelope.grant.providerId,
    manifestId: record.envelope.grant.manifestId,
    manifestVersion: record.envelope.grant.manifestVersion,
    approvedBy: record.envelope.approvedBy,
    keyId: record.envelope.keyId,
    issuedAt: record.envelope.grant.issuedAt,
    expiresAt: record.envelope.grant.expiresAt,
    requestBudget: record.envelope.grant.requestBudget,
    registeredAt: record.recordedAt
  };
}

function networkGrantPage(
  records: readonly StoredNetworkAccessGrantRecord[],
  payloadValue: unknown
): unknown {
  const { cursor, limit } = decisionPagePayload(payloadValue);
  const normalized = records
    .map(networkGrantSummary)
    .sort((left, right) => String(left["grantId"]).localeCompare(String(right["grantId"])));
  const eligible = cursor === null
    ? normalized
    : normalized.filter((entry) => String(entry["grantId"]) > cursor);
  const items = eligible.slice(0, limit);
  const nextCursor = eligible.length > items.length
    ? String(items.at(-1)?.["grantId"] ?? "") || null
    : null;
  const body = { items, nextCursor, limit };
  return boundedAuthorityResponse(
    { ...body, pageHash: sha256(stableStringify(body)) },
    "Network access grant page"
  );
}

function stringHeaders(value: unknown): Readonly<Record<string, string>> {
  const candidate = objectPayload(value);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(candidate)) {
    if (typeof headerValue !== "string") {
      throw new Error(`Discovery header must be a string: ${name}`);
    }
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
}

function recordSummary(value: unknown): Record<string, unknown> {
  const record = objectPayload(value);
  return {
    domain: requiredString(record["domain"], "Record domain"),
    recordId: requiredString(record["recordId"], "Record id"),
    version: requiredVersion(record["version"]),
    valueHash: requiredString(record["valueHash"], "Record value hash"),
    recordedAt: requiredString(record["recordedAt"], "Record time")
  };
}

function bindPersistentNetworkRateGate(
  persistentGate: PersistentGovernedRateGate,
  authorityRequestId: string,
  grantDigest: string
): GovernedRateGate {
  let attemptIndex = 0;
  return {
    consume(request) {
      const currentAttempt = attemptIndex;
      attemptIndex += 1;
      return persistentGate.consume({
        ...request,
        authorityRequestId,
        attemptIndex: currentAttempt,
        grantDigest
      });
    }
  };
}

function dedupeCandidateForOpportunity(
  opportunity: OpportunityRecord,
  observationId: string
): DedupeCandidate {
  return {
    candidateId: opportunity.opportunityId,
    observationId,
    providerId: opportunity.source as DiscoveryProviderId,
    sourceRecordId: opportunity.sourceId,
    canonicalUrl: opportunity.canonicalUrl,
    applyUrl: opportunity.applyUrl,
    company: opportunity.company,
    companyDomain: null,
    roleTitle: opportunity.roleTitle,
    location: opportunity.locationText,
    postedAt: opportunity.postedAt,
    descriptionDigest: opportunity.descriptionHash
  };
}

function likelyDedupeNeighbor(left: DedupeCandidate, right: DedupeCandidate): boolean {
  if (left.canonicalUrl === right.canonicalUrl) return true;
  if (left.applyUrl !== null && left.applyUrl === right.applyUrl) return true;
  return left.company.trim().toLowerCase() === right.company.trim().toLowerCase()
    || left.roleTitle.trim().toLowerCase() === right.roleTitle.trim().toLowerCase();
}

function decisionPagePayload(value: unknown): { cursor: string | null; limit: number } {
  const payload = objectPayload(value);
  const allowed = new Set(["cursor", "limit"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new Error(`Decision list payload contains an unexpected field: ${key}`);
  }
  const cursor = payload["cursor"] ?? null;
  if (cursor !== null && (typeof cursor !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cursor))) {
    throw new Error("Decision list cursor is invalid");
  }
  const limit = payload["limit"] ?? DEFAULT_DECISION_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_DECISION_PAGE_LIMIT) {
    throw new Error(`Decision list limit must be between 1 and ${MAX_DECISION_PAGE_LIMIT}`);
  }
  return { cursor: cursor as string | null, limit: limit as number };
}

function decisionRecordPage(records: readonly unknown[], payloadValue: unknown): unknown {
  const { cursor, limit } = decisionPagePayload(payloadValue);
  const normalized = records.map((value) => {
    const current = objectPayload(value);
    const recordId = requiredString(current["recordId"], "Decision record id");
    return {
      domain: requiredString(current["domain"], "Decision record domain"),
      recordId,
      version: requiredVersion(current["version"]),
      valueHash: requiredString(current["valueHash"], "Decision record value hash"),
      authority: current["authority"],
      recordedAt: requiredString(current["recordedAt"], "Decision record time")
    };
  }).sort((left, right) => left.recordId.localeCompare(right.recordId));
  const eligible = cursor === null ? normalized : normalized.filter((entry) => entry.recordId > cursor);
  const items = eligible.slice(0, limit);
  const nextCursor = eligible.length > items.length ? items.at(-1)?.recordId ?? null : null;
  const body = { items, nextCursor, limit };
  return boundedAuthorityResponse(
    { ...body, pageHash: sha256(stableStringify(body)) },
    "Decision record page"
  );
}

interface DiscoveryReviewProjection {
  opportunityId: string;
  version: number;
  roleTitle: string;
  company: string;
  locationText: string;
  providerId: DiscoveryProviderId;
  sourceKey: string;
  status: "ready" | "needs_review" | "blocked";
  liveness: LivenessAssessment["state"] | "unassessed";
  livenessConfidence: LivenessAssessment["confidence"] | null;
  truthDisposition: OpportunityTruthRecord["disposition"] | "unassessed";
  truthBlockers: string[];
  duplicateStatus: DedupeDecision["outcome"] | "unassessed";
  duplicateCandidateIds: string[];
  taxonomyConfidence: number | null;
  campaignId: string | null;
  updatedAt: string;
  evidenceRecordIds: string[];
}

interface CandidateDedupeProjection {
  outcome: DedupeDecision["outcome"];
  candidateIds: string[];
  recordId: string;
}

const DEDUPE_REVIEW_PRIORITY: Readonly<Record<DedupeDecision["outcome"], number>> = Object.freeze({
  distinct: 1,
  merge: 2,
  review: 3
});

function latestDedupeByCandidate(records: readonly {
  recordId: string;
  recordedAt: string;
  value: DedupeResult;
}[]): Map<string, CandidateDedupeProjection> {
  const result = new Map<string, CandidateDedupeProjection>();
  const orderedRecords = [...records].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt) || left.recordId.localeCompare(right.recordId)
  );
  for (const record of orderedRecords) {
    const decisionsByCandidate = new Map<string, DedupeDecision[]>();
    for (const decision of record.value.decisions) {
      for (const candidateId of [decision.leftCandidateId, decision.rightCandidateId]) {
        const decisions = decisionsByCandidate.get(candidateId) ?? [];
        decisions.push(decision);
        decisionsByCandidate.set(candidateId, decisions);
      }
    }
    for (const [candidateId, decisions] of decisionsByCandidate) {
      const outcome = decisions.reduce<DedupeDecision["outcome"]>((current, decision) =>
        DEDUPE_REVIEW_PRIORITY[decision.outcome] > DEDUPE_REVIEW_PRIORITY[current]
          ? decision.outcome
          : current,
      "distinct");
      const candidateIds = [...new Set(decisions.map((decision) =>
        decision.leftCandidateId === candidateId ? decision.rightCandidateId : decision.leftCandidateId
      ))].sort();
      result.set(candidateId, { outcome, candidateIds, recordId: record.recordId });
    }
  }
  return result;
}

function latestByKey<T extends { recordedAt: string }>(
  records: readonly T[],
  keyOf: (record: T) => string | null
): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    const key = keyOf(record);
    if (key === null) continue;
    const current = result.get(key);
    if (!current || record.recordedAt > current.recordedAt) result.set(key, record);
  }
  return result;
}

function discoveryReviewPage(itemsValue: readonly DiscoveryReviewProjection[], payloadValue: unknown): unknown {
  const { cursor, limit } = decisionPagePayload(payloadValue);
  const normalized = [...itemsValue].sort((left, right) => left.opportunityId.localeCompare(right.opportunityId));
  const eligible = cursor === null ? normalized : normalized.filter((item) => item.opportunityId > cursor);
  const items = eligible.slice(0, limit);
  const nextCursor = eligible.length > items.length ? items.at(-1)?.opportunityId ?? null : null;
  const body = { items, nextCursor, limit };
  return boundedAuthorityResponse(
    { ...body, pageHash: sha256(stableStringify(body)) },
    "Discovery review page"
  );
}

function eventIdForRequest(requestId: string): string {
  return `EVT-CMD-${sha256(requestId).slice("sha256:".length)}`;
}

function internalAuthorityRequestId(requestId: string, purpose: string): string {
  return `REQ-${sha256(`${requestId}:${purpose}`).slice("sha256:".length, "sha256:".length + 48)}`;
}

function checkpointIdForRequest(requestId: string): string {
  return `CHK-${sha256(requestId).slice("sha256:".length)}`;
}

function uuidForRequest(requestId: string): string {
  const hex = sha256(`onboarding:${requestId}`).slice("sha256:".length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function productDomain(value: unknown): ProductDomainName {
  if (typeof value !== "string" || !PRODUCT_DOMAIN_NAMES.includes(value as ProductDomainName)) {
    throw new Error("Product domain is invalid");
  }
  return value as ProductDomainName;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Expected version must be a non-negative safe integer");
  }
  return value as number;
}

function canonicalDate(value: unknown, label: string): Date {
  const text = requiredString(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    throw new Error(`${label} must be a canonical ISO date-time`);
  }
  return new Date(timestamp);
}

function credentialInputFormat(value: unknown): CredentialInputFormat {
  if (
    value !== "json"
    && value !== "json-ld"
    && value !== "compact-jws"
    && value !== "baked-png"
    && value !== "baked-svg"
  ) {
    throw new Error("Credential input format is invalid");
  }
  return value;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function authorityBinding(event: StoredEvent<AuthorityEventPayload>): AuthorityBinding | null {
  return event.payload.authority ?? event.payload.metadata?.authority ?? null;
}

function authorityResponse(event: StoredEvent<AuthorityEventPayload>): unknown {
  if (event.payload.response !== undefined) return event.payload.response;
  if (event.payload.config !== undefined) return event.payload.config;
  throw new Error("Authority event does not contain a replayable response");
}

export class RuntimeAuthority {
  private readonly repository: RuntimeRepository;
  private readonly decisionIntelligence: DecisionIntelligenceRepositories;
  private readonly networkGrants: NetworkAccessGrantRepository;

  public constructor(
    private readonly store: EncryptedEventStore,
    private readonly credentials: CredentialStore,
    private readonly runtimeRoot: string,
    private readonly artifactVault: ArtifactVault | null = null,
    private readonly options: RuntimeAuthorityOptions = {}
  ) {
    this.repository = new RuntimeRepository(store);
    this.decisionIntelligence = new DecisionIntelligenceRepositories(store);
    this.networkGrants = new NetworkAccessGrantRepository(store);
  }

  private async trustedNetworkIssuers(): Promise<readonly TrustedNetworkAccessGrantIssuer[]> {
    return (await this.repository.listTrustedApprovers()).map((approver) => ({
      approvedBy: approver.approvedBy,
      keyId: approver.keyId,
      publicKeyPem: approver.publicKeyPem
    }));
  }

  private createDiscoveryBroker(context: GovernedDiscoveryBrokerContext): GovernedFetchBroker {
    return this.options.createGovernedDiscoveryBroker?.(context)
      ?? createDefaultGovernedFetchBroker(context.grantVerifier, undefined, context.rateGate);
  }

  private async persistDiscoveryDecision<T>(input: {
    value: T;
    recordId: string;
    authorityRequestId: string;
    get: (recordId: string) => Promise<{ value: T } | null>;
    record: (command: {
      value: T;
      expectedVersion: number;
      authorityRequestId: string;
      now: Date;
    }) => Promise<unknown>;
    now: Date;
  }): Promise<unknown> {
    const existing = await input.get(input.recordId);
    if (existing) {
      if (stableStringify(existing.value) !== stableStringify(input.value)) {
        throw new Error(`Discovery content-addressed record id was rebound: ${input.recordId}`);
      }
      return existing;
    }
    return input.record({
      value: input.value,
      expectedVersion: 0,
      authorityRequestId: input.authorityRequestId,
      now: input.now
    });
  }

  private recordPersistedResponse(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    response: unknown,
    now: Date
  ): void {
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash: sha256(stableStringify(response)),
      completedAt: now.toISOString()
    });
  }

  private authorityMetadata(request: AuthorityRequest, requestHash: string, response: unknown): Record<string, unknown> {
    return {
      authority: {
        requestId: request.id,
        requestHash,
        operation: request.operation,
        responseHash: sha256(stableStringify(response))
      }
    };
  }

  private async saveOnboardingResponse(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    session: OnboardingSession,
    now: Date
  ): Promise<OnboardingSession> {
    await this.repository.saveOnboardingSession({
      session,
      eventId,
      eventType: `${request.operation}-completed`,
      occurredAt: now,
      metadata: this.authorityMetadata(request, requestHash, session)
    });
    this.recordPersistedResponse(request, requestHash, eventId, session, now);
    return session;
  }

  private async findProfileImportPlan(planHash: string): Promise<ProfileImportPlan | null> {
    const events = await this.store.readAll<{ response?: unknown }>();
    for (const event of [...events].reverse()) {
      if (event.eventType !== "profile-import-plan-completed") continue;
      const response = event.payload.response as ProfileImportPlan | undefined;
      if (!response || response.planHash !== planHash) continue;
      assertProfileImportPlan(response);
      return response;
    }
    return null;
  }

  private readArtifactJson<T>(manifestValue: unknown, label: string, maximumBytes: number): T {
    if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
    assertArtifactManifest(manifestValue);
    assertSchema("artifact-manifest", manifestValue);
    if (manifestValue.sizeBytes > maximumBytes) {
      throw new Error(`${label} exceeds the configured artifact size limit`);
    }
    const plaintext = this.artifactVault.read(manifestValue);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
    } finally {
      plaintext.fill(0);
    }
  }

  private async ensureInternalArtifactManifest(
    manifest: ArtifactManifest,
    eventId: string,
    occurredAt: Date,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const existing = await this.store.readEvent<{ manifest?: ArtifactManifest; response?: ArtifactManifest }>(eventId);
    if (existing) {
      const boundManifest = existing.payload.response ?? existing.payload.manifest;
      if (
        existing.aggregateType !== "artifact-manifest"
        || existing.aggregateId !== manifest.storageLocator
        || !boundManifest
        || stableStringify(boundManifest) !== stableStringify(manifest)
      ) {
        throw new Error("Internal artifact event is not bound to the generated artifact manifest");
      }
      return;
    }
    await this.repository.saveArtifactManifest({ manifest, eventId, occurredAt, metadata });
  }

  private async credentialOriginalManifest(passport: CredentialPassportEntry): Promise<ArtifactManifest> {
    const matches = (await this.repository.listArtifactManifests()).filter((manifest) =>
      manifest.contentHash === passport.original.hash
      && manifest.sizeBytes === passport.original.byteLength
    );
    if (matches.length !== 1) {
      throw new Error("Credential passport original is not uniquely bound to an encrypted artifact manifest");
    }
    return matches[0]!;
  }

  private exportArtifactToFile(manifestValue: unknown, outputPathValue: unknown): {
    outputPath: string;
    contentHash: string;
    sizeBytes: number;
    recoveredExisting: boolean;
  } {
    if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
    assertArtifactManifest(manifestValue);
    assertSchema("artifact-manifest", manifestValue);
    const outputPath = requiredString(outputPathValue, "Artifact export path");
    if (!path.isAbsolute(outputPath)) throw new Error("Artifact export path must be absolute");
    const resolvedOutputPath = path.resolve(outputPath);
    const parent = path.dirname(resolvedOutputPath);
    const parentMetadata = statSync(parent);
    if (!parentMetadata.isDirectory()) throw new Error("Artifact export parent must be a directory");

    const verifyExisting = (): boolean => {
      let descriptor: number;
      try {
        descriptor = openSync(resolvedOutputPath, "r");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }

      try {
        const openedMetadata = fstatSync(descriptor);
        const assertPathBinding = (): void => {
          let pathMetadata;
          try {
            pathMetadata = lstatSync(resolvedOutputPath);
          } catch (error) {
            if (errorCode(error) === "ENOENT") {
              throw new Error("Artifact export target changed while it was being verified");
            }
            throw error;
          }
          if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || !openedMetadata.isFile()) {
            throw new Error("Artifact export target must be a regular file and must not be a symbolic link");
          }
          if (pathMetadata.dev !== openedMetadata.dev || pathMetadata.ino !== openedMetadata.ino) {
            throw new Error("Artifact export target changed while it was being verified");
          }
        };

        assertPathBinding();
        if (openedMetadata.size !== manifestValue.sizeBytes) {
          throw new Error("Artifact export target already exists with different content");
        }

        const existing = readFileSync(descriptor);
        try {
          if (sha256(existing) !== manifestValue.contentHash) {
            throw new Error("Artifact export target already exists with different content");
          }
          const finalMetadata = fstatSync(descriptor);
          if (
            finalMetadata.dev !== openedMetadata.dev
            || finalMetadata.ino !== openedMetadata.ino
            || finalMetadata.size !== openedMetadata.size
            || finalMetadata.mtimeMs !== openedMetadata.mtimeMs
            || finalMetadata.ctimeMs !== openedMetadata.ctimeMs
          ) {
            throw new Error("Artifact export target changed while it was being verified");
          }
          assertPathBinding();
        } finally {
          existing.fill(0);
        }
      } finally {
        closeSync(descriptor);
      }
      return true;
    };

    if (verifyExisting()) {
      return {
        outputPath: resolvedOutputPath,
        contentHash: manifestValue.contentHash,
        sizeBytes: manifestValue.sizeBytes,
        recoveredExisting: true
      };
    }

    const plaintext = this.artifactVault.read(manifestValue);
    try {
      try {
        writeFileSync(resolvedOutputPath, plaintext, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST" || !verifyExisting()) throw error;
        return {
          outputPath: resolvedOutputPath,
          contentHash: manifestValue.contentHash,
          sizeBytes: manifestValue.sizeBytes,
          recoveredExisting: true
        };
      }
    } finally {
      plaintext.fill(0);
    }
    if (!verifyExisting()) throw new Error("Artifact export did not create the requested file");
    return {
      outputPath: resolvedOutputPath,
      contentHash: manifestValue.contentHash,
      sizeBytes: manifestValue.sizeBytes,
      recoveredExisting: false
    };
  }

  private async replayOrReject(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string
  ): Promise<{ replayed: true; response: unknown } | null> {
    const receipt = this.store.findAuthorityReceipt(request.id);
    if (receipt) {
      if (receipt.requestHash !== requestHash || receipt.operation !== request.operation) {
        throw new Error("Authority request id was reused with different parameters");
      }
      if (!receipt.eventId || receipt.eventId !== eventId) {
        throw new Error("Authority receipt does not reference the deterministic replay event");
      }
      const event = await this.store.readEvent<AuthorityEventPayload>(receipt.eventId);
      if (!event) throw new Error("Authority receipt references a missing event");
      if (receipt.completedAt !== event.occurredAt) {
        throw new Error("Authority receipt completion time is not bound to its event");
      }
      const binding = authorityBinding(event);
      if (
        !binding
        || binding.requestId !== request.id
        || binding.requestHash !== requestHash
        || binding.operation !== request.operation
        || binding.responseHash !== receipt.responseHash
      ) {
        throw new Error("Authority receipt is not bound to its authenticated event");
      }
      const response = authorityResponse(event);
      if (sha256(stableStringify(response)) !== receipt.responseHash) {
        throw new Error("Authority replay response does not match its receipt");
      }
      return { replayed: true, response };
    }

    const committedEvent = await this.store.readEvent<AuthorityEventPayload>(eventId);
    if (!committedEvent) return null;
    const binding = authorityBinding(committedEvent);
    if (!binding || binding.requestId !== request.id || binding.requestHash !== requestHash || binding.operation !== request.operation) {
      throw new Error("Deterministic authority event id is already bound to another request");
    }
    const response = authorityResponse(committedEvent);
    const responseHash = sha256(stableStringify(response));
    if (binding.responseHash !== responseHash) throw new Error("Authority event response binding is invalid");
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: committedEvent.occurredAt
    });
    return { replayed: true, response };
  }

  private async recordCommand(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    response: unknown,
    now: Date
  ): Promise<void> {
    const responseHash = sha256(stableStringify(response));
    await this.store.append({
      eventId,
      aggregateType: "authority-command",
      aggregateId: request.id,
      eventType: `${request.operation}-completed`,
      schemaVersion: 1,
      occurredAt: now,
      payload: {
        authority: {
          requestId: request.id,
          requestHash,
          operation: request.operation,
          responseHash
        },
        response
      }
    });
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: now.toISOString()
    });
  }

  private async recordDecisionCommand(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    response: AutoApplyDecision,
    entry: ActionLedgerEntry,
    now: Date
  ): Promise<void> {
    assertSchema("action-ledger-entry", entry);
    const responseHash = sha256(stableStringify(response));
    await this.store.append({
      eventId,
      aggregateType: "action-ledger",
      aggregateId: entry.actionId,
      eventType: "auto-apply-decision-recorded",
      schemaVersion: 1,
      occurredAt: now,
      payload: {
        authority: {
          requestId: request.id,
          requestHash,
          operation: request.operation,
          responseHash
        },
        entry,
        response
      }
    });
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: now.toISOString()
    });
  }

  private async mutateConfig(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    transform: (current: Awaited<ReturnType<RuntimeRepository["loadAutoApplyConfig"]>>) => Awaited<ReturnType<RuntimeRepository["loadAutoApplyConfig"]>>,
    now: Date
  ): Promise<unknown> {
    const config = transform(await this.repository.loadAutoApplyConfig());
    const responseHash = sha256(stableStringify(config));
    await this.repository.saveAutoApplyConfig({
      config,
      eventId,
      eventType: `${request.operation}-completed`,
      occurredAt: now,
      metadata: {
        authority: {
          requestId: request.id,
          requestHash,
          operation: request.operation,
          responseHash
        }
      }
    });
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: now.toISOString()
    });
    return config;
  }

  private async assertOnboardingStepPrerequisites(
    session: OnboardingSession,
    step: ActionableOnboardingStep,
    result: OnboardingStepResultInput
  ): Promise<void> {
    const repositories = new ProductRepositories(this.store);
    if (step === "profile-import") {
      if (session.initializationMode === "profile") {
        if (result.profilePlanHash === undefined) throw new Error("Profile import step requires a plan hash");
        if (!(await this.findProfileImportPlan(result.profilePlanHash))) {
          throw new Error("Profile import step plan hash is not present in authenticated history");
        }
      } else {
        const profiles = await repositories.profiles.list();
        if (!profiles.some((record) => record.value.profileScope === "synthetic")) {
          throw new Error("Demo profile import step requires a persisted synthetic profile");
        }
      }
    }
    if (step === "claim-review") {
      if (session.initializationMode === "profile") {
        if (session.profilePlanHash === null) throw new Error("Profile claim review requires an active plan hash");
        const plan = await this.findProfileImportPlan(session.profilePlanHash);
        if (!plan) throw new Error("Profile claim review plan is missing from authenticated history");
        const profile = await repositories.profiles.get(careerTwinFromImportPlan(plan).twinId);
        if (!profile) throw new Error("Profile claim review requires the approved plan to be applied");
      } else {
        const profiles = await repositories.profiles.list();
        if (!profiles.some((record) => record.value.profileScope === "synthetic")) {
          throw new Error("Demo claim review requires a persisted synthetic profile");
        }
      }
    }
    if (step === "first-discovery" && (await repositories.opportunities.list()).length === 0) {
      throw new Error("First discovery requires a persisted opportunity");
    }
  }

  public async execute(request: AuthorityRequest, now = new Date()): Promise<unknown> {
    assertRequestId(request.id);
    const requestHash = sha256(stableStringify({ operation: request.operation, payload: request.payload }));
    const eventId = eventIdForRequest(request.id);

    if (request.operation === "health") {
      const checkpointStatus = await verifyCheckpointChain(this.store, this.credentials);
      const head = await this.store.chainHead();
      return {
        status: "ok",
        databaseId: await this.store.databaseId(),
        migrations: this.store.migrations(),
        eventCount: head.eventCount,
        checkpointStatus,
        compiledAdapters: compiledAdapterCapabilities()
      };
    }
    if (request.operation === "auto-apply-status") {
      const config = await this.repository.loadAutoApplyConfig();
      return {
        config,
        effectiveAdapters: resolveEffectiveAdapterCapabilities(config.adapterAllowlist)
      };
    }
    if (request.operation === "legacy-import-plan") {
      return summarizeLegacyImportPlan(planLegacyImport(this.runtimeRoot));
    }
    if (request.operation === "checkpoint-verify") {
      return verifyCheckpointChain(this.store, this.credentials);
    }
    if (request.operation === "approver-list") {
      return this.repository.listTrustedApprovers();
    }
    if (request.operation === "collector-list") {
      return this.repository.listTrustedCollectors();
    }
    if (request.operation === "network-grant-list") {
      return networkGrantPage(await this.networkGrants.list(), request.payload);
    }
    if (request.operation === "discovery-review-list") {
      const products = new ProductRepositories(this.store);
      const [opportunities, truthRecords, livenessRecords, dedupeRecords] = await Promise.all([
        products.opportunities.list(),
        this.decisionIntelligence.listOpportunityTruthRecords(),
        this.decisionIntelligence.listLivenessAssessments(),
        this.decisionIntelligence.listDedupeResults()
      ]);
      const truthByOpportunity = latestByKey(truthRecords, (record) => record.value.opportunityKey);
      const livenessBySource = latestByKey(livenessRecords, (record) => record.value.sourceKey);
      const duplicateByCandidate = latestDedupeByCandidate(dedupeRecords);
      const projections = opportunities.flatMap((record): DiscoveryReviewProjection[] => {
        const opportunity = record.value;
        if (opportunity.source === "manual") return [];
        const providerId = providerManifestById(opportunity.source).providerId as DiscoveryProviderId;
        const sourceKey = `${providerId}:${opportunity.sourceId}`;
        const truth = truthByOpportunity.get(opportunity.opportunityId);
        const liveness = livenessBySource.get(sourceKey);
        const duplicate = duplicateByCandidate.get(opportunity.opportunityId);
        const duplicateCandidateIds = duplicate?.candidateIds ?? [];
        const value = opportunity as unknown as Record<string, unknown>;
        const taxonomyConfidence = typeof value["taxonomyConfidence"] === "number"
          && Number.isFinite(value["taxonomyConfidence"])
          && value["taxonomyConfidence"] >= 0
          && value["taxonomyConfidence"] <= 1
          ? value["taxonomyConfidence"]
          : null;
        const campaignId = typeof value["campaignId"] === "string" && value["campaignId"].trim().length > 0
          ? value["campaignId"]
          : null;
        const livenessState = liveness?.value.state ?? "unassessed";
        const truthDisposition = truth?.value.disposition ?? "unassessed";
        const duplicateStatus = duplicate?.outcome ?? "unassessed";
        const blocked = livenessState === "closed" || truthDisposition === "blocked";
        const needsReview = !blocked && (
          livenessState !== "live"
          || truthDisposition !== "actionable"
          || duplicateStatus === "review"
          || duplicateStatus === "merge"
        );
        return [{
          opportunityId: opportunity.opportunityId,
          version: record.version,
          roleTitle: opportunity.roleTitle,
          company: opportunity.company,
          locationText: opportunity.locationText,
          providerId,
          sourceKey,
          status: blocked ? "blocked" : needsReview ? "needs_review" : "ready",
          liveness: livenessState,
          livenessConfidence: liveness?.value.confidence ?? null,
          truthDisposition,
          truthBlockers: truth?.value.blockers.map((blocker) => `${blocker.field}:${blocker.code}`) ?? [],
          duplicateStatus,
          duplicateCandidateIds,
          taxonomyConfidence,
          campaignId,
          updatedAt: record.recordedAt,
          evidenceRecordIds: [truth?.recordId, liveness?.recordId, duplicate?.recordId]
            .filter((recordId): recordId is string => typeof recordId === "string")
        }];
      });
      return discoveryReviewPage(projections, request.payload);
    }
    if (request.operation === "audit-export") {
      await verifyCheckpointChain(this.store, this.credentials);
      return {
        databaseId: await this.store.databaseId(),
        chainHead: await this.store.chainHead(),
        migrations: this.store.migrations(),
        checkpoints: this.store.listSignedCheckpoints(),
        ledgerSummary: await this.repository.summarizeLedger()
      };
    }
    if (request.operation === "artifact-list") {
      return this.repository.listArtifactManifests();
    }
    if (request.operation === "onboarding-status") {
      return this.repository.loadOnboardingSession();
    }
    if (request.operation === "profile-import-plan-get") {
      objectPayload(request.payload);
      const session = await this.repository.loadOnboardingSession();
      if (!session || session.initializationMode !== "profile" || session.profilePlanHash === null) {
        throw new Error("No active profile import plan is bound to onboarding");
      }
      const plan = await this.findProfileImportPlan(session.profilePlanHash);
      if (!plan) throw new Error("The onboarding profile import plan is missing from authenticated history");
      return plan;
    }
    if (request.operation === "domain-get" || request.operation === "domain-list") {
      const payload = objectPayload(request.payload);
      const domain = productDomain(payload["domain"]);
      const repository = new ProductRepositories(this.store).repository(domain);
      const includeArchived = payload["includeArchived"] === true;
      if (request.operation === "domain-list") return repository.list(includeArchived);
      const recordId = requiredString(payload["recordId"], "Domain record id");
      return repository.get(recordId, includeArchived);
    }
    if (request.operation === "tracker-list" || request.operation === "tracker-get") {
      const payload = objectPayload(request.payload);
      const tracker = new ApplicationTracker(new ProductRepositories(this.store));
      if (request.operation === "tracker-list") return tracker.list(payload["includeArchived"] === true);
      return tracker.get(requiredString(payload["attemptId"], "Application attempt id"));
    }
    switch (request.operation) {
      case "source-observation-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getSourceObservation(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Source observation id")
        ), "Source observation");
      case "source-observation-list":
        return decisionRecordPage(await this.decisionIntelligence.listSourceObservations(), request.payload);
      case "opportunity-truth-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getOpportunityTruth(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Opportunity truth record id")
        ), "Opportunity truth record");
      case "opportunity-truth-list":
        return decisionRecordPage(await this.decisionIntelligence.listOpportunityTruthRecords(), request.payload);
      case "liveness-assessment-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getLivenessAssessment(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Liveness assessment id")
        ), "Liveness assessment");
      case "liveness-assessment-list":
        return decisionRecordPage(await this.decisionIntelligence.listLivenessAssessments(), request.payload);
      case "dedupe-result-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getDedupeResult(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Dedupe result id")
        ), "Dedupe result");
      case "dedupe-result-list":
        return decisionRecordPage(await this.decisionIntelligence.listDedupeResults(), request.payload);
      case "taxonomy-snapshot-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getTaxonomySnapshot(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Taxonomy snapshot id")
        ), "Taxonomy snapshot");
      case "taxonomy-snapshot-list":
        return decisionRecordPage(await this.decisionIntelligence.listTaxonomySnapshots(), request.payload);
      case "taxonomy-query": {
        const payload = exactObjectPayload(request.payload, ["limit", "minimumScore", "queries", "snapshotId"]);
        const snapshotId = requiredString(payload["snapshotId"], "Taxonomy snapshot id");
        const queries = payload["queries"];
        if (
          !Array.isArray(queries)
          || queries.length < 1
          || queries.length > 50
          || queries.some((query) => typeof query !== "string" || query.trim().length < 1 || query.length > 512)
        ) {
          throw new Error("Taxonomy query requires between 1 and 50 bounded text queries");
        }
        const limit = payload["limit"];
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 25) {
          throw new Error("Taxonomy query result limit must be between 1 and 25");
        }
        const minimumScore = payload["minimumScore"];
        if (typeof minimumScore !== "number" || !Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) {
          throw new Error("Taxonomy minimum score must be between 0 and 1");
        }
        const stored = await this.decisionIntelligence.getTaxonomySnapshot(snapshotId);
        if (!stored) throw new Error(`Taxonomy snapshot was not found: ${snapshotId}`);
        return boundedAuthorityResponse({
          snapshotId,
          source: stored.value.source,
          version: stored.value.version,
          contentHash: stored.value.contentHash,
          matches: queries.map((query) => ({
            query: query.trim(),
            results: rankTaxonomyConcepts(query.trim(), stored.value, {
              limit: limit as number,
              minimumScore
            })
          }))
        }, "Taxonomy query result");
      }
      case "taxonomy-mapping-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getTaxonomyMappingSet(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Taxonomy mapping id")
        ), "Taxonomy mapping set");
      case "taxonomy-mapping-list":
        return decisionRecordPage(await this.decisionIntelligence.listTaxonomyMappingSets(), request.payload);
      case "assurance-case-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getCareerAssuranceCase(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Assurance case id")
        ), "Career Assurance Case");
      case "assurance-case-list":
        return decisionRecordPage(await this.decisionIntelligence.listCareerAssuranceCases(), request.payload);
      case "credential-passport-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getCredentialPassport(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Credential passport id")
        ), "Credential passport");
      case "credential-passport-list":
        return decisionRecordPage(await this.decisionIntelligence.listCredentialPassports(), request.payload);
      case "credential-mapping-get":
        return boundedAuthorityResponse(await this.decisionIntelligence.getCredentialMappingPlan(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Credential mapping id")
        ), "Credential mapping plan");
      case "credential-mapping-list":
        return decisionRecordPage(await this.decisionIntelligence.listCredentialMappingPlans(), request.payload);
      case "campaign-get":
        return new ProductRepositories(this.store).campaigns.get(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Campaign id"),
          true
        );
      case "campaign-list":
        return new ProductRepositories(this.store).campaigns.list(
          exactObjectPayload(request.payload, ["includeArchived"])["includeArchived"] === true
        );
      case "outcome-get":
        return new ProductRepositories(this.store).outcomes.get(
          requiredString(exactObjectPayload(request.payload, ["recordId"])["recordId"], "Outcome id"),
          true
        );
      case "outcome-list":
        return new ProductRepositories(this.store).outcomes.list(
          exactObjectPayload(request.payload, ["includeArchived"])["includeArchived"] === true
        );
    }

    await verifyCheckpointChain(this.store, this.credentials);
    if (!DECISION_INTELLIGENCE_RECORD_OPERATIONS.has(request.operation)) {
      const replay = await this.replayOrReject(request, requestHash, eventId);
      if (replay) {
        if (request.operation === "artifact-export") {
          const payload = exactObjectPayload(request.payload, ["manifest", "outputPath"]);
          this.exportArtifactToFile(payload["manifest"], payload["outputPath"]);
        }
        return replay.response;
      }
    }

    if (request.operation === "network-grant-register") {
      const payload = exactObjectPayload(request.payload, ["envelope", "scopeUrl"]);
      assertSchema("discovery-signed-network-access-grant", payload["envelope"]);
      const envelope = payload["envelope"] as SignedNetworkAccessGrantEnvelope;
      const providerId = discoveryProviderId(envelope.grant.providerId);
      const provider = providerManifestById(providerId);
      if (provider.supportStatus !== "contract-tested-ga" || provider.discoveryMode === "assist-only") {
        throw new Error(`Discovery provider is not authorized for governed execution: ${providerId}`);
      }
      const scopeUrl = payload["scopeUrl"];
      if (scopeUrl !== null && typeof scopeUrl !== "string") {
        throw new Error("Network grant scope URL must be null or a string");
      }
      const manifest = scopeUrl === null
        ? provider.egress
        : buildOperatorScopedEgressManifest(providerId, scopeUrl);
      const verification = verifySignedNetworkAccessGrant(envelope, {
        manifest,
        verifiedAt: now.toISOString(),
        trustedIssuers: await this.trustedNetworkIssuers()
      });
      if (!verification.verified) {
        throw new Error(`Signed network access grant verification failed: ${verification.reasons.join(", ")}`);
      }
      const stored = await this.networkGrants.save(envelope, now);
      const response = networkGrantSummary(stored);
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }

    if (request.operation === "discovery-run") {
      const payload = exactObjectPayload(request.payload, [
        "companyHint",
        "grantId",
        "headers",
        "operatorScopedTarget",
        "providerId",
        "sourceKey",
        "url"
      ]);
      const providerId = discoveryProviderId(payload["providerId"]);
      const provider = providerManifestById(providerId);
      if (provider.supportStatus !== "contract-tested-ga" || provider.discoveryMode === "assist-only") {
        throw new Error(`Discovery provider is not authorized for governed execution: ${providerId}`);
      }
      const grantId = requiredString(payload["grantId"], "Network access grant id");
      const sourceKey = requiredString(payload["sourceKey"], "Discovery source key");
      if (sourceKey.length > 512) throw new Error("Discovery source key exceeds 512 characters");
      const url = requiredString(payload["url"], "Discovery URL");
      const companyHint = payload["companyHint"];
      if (companyHint !== null && (typeof companyHint !== "string" || companyHint.trim().length === 0)) {
        throw new Error("Discovery company hint must be null or a non-empty string");
      }
      if (typeof payload["operatorScopedTarget"] !== "boolean") {
        throw new Error("Discovery operator scoped target flag must be boolean");
      }
      const operatorScopedTarget = payload["operatorScopedTarget"];
      const headers = stringHeaders(payload["headers"]);
      const storedGrant = await this.networkGrants.get(grantId);
      if (!storedGrant) throw new Error(`Network access grant was not found: ${grantId}`);
      if (storedGrant.envelope.grant.providerId !== providerId) {
        throw new Error("Network access grant is bound to another discovery provider");
      }
      const manifest = operatorScopedTarget
        ? buildOperatorScopedEgressManifest(providerId, url)
        : provider.egress;
      const verification = verifySignedNetworkAccessGrant(storedGrant.envelope, {
        manifest,
        verifiedAt: now.toISOString(),
        trustedIssuers: await this.trustedNetworkIssuers()
      });
      if (!verification.verified) {
        throw new Error(`Stored network access grant verification failed: ${verification.reasons.join(", ")}`);
      }

      const grantVerifier = createSignedNetworkAccessGrantVerifier({
        resolveEnvelope: async (grant) => this.networkGrants.getEnvelope(grant.grantId),
        trustedIssuers: async () => this.trustedNetworkIssuers()
      });
      const persistentRateGate = new PersistentGovernedRateGate(this.store, this.networkGrants);
      const rateGate = bindPersistentNetworkRateGate(
        persistentRateGate,
        request.id,
        storedGrant.grantDigest
      );
      const runtime = new GovernedProviderRuntime(
        this.createDiscoveryBroker({ grantVerifier, rateGate }),
        { now: () => new Date(now) }
      );
      const result = await runtime.discover({
        providerId,
        sourceKey,
        url,
        grant: storedGrant.envelope.grant,
        companyHint: companyHint as string | null,
        headers,
        cacheMode: "no-store",
        operatorScopedTarget
      });
      if ((result.parseResult?.postings.length ?? 0) > MAX_DISCOVERY_POSTINGS_PER_RUN) {
        throw new Error(`Discovery result exceeds ${MAX_DISCOVERY_POSTINGS_PER_RUN} postings`);
      }

      const endpointObservationRecord = await this.persistDiscoveryDecision<SourceObservation>({
        value: result.observation,
        recordId: result.observation.observationId,
        authorityRequestId: internalAuthorityRequestId(request.id, "discovery-endpoint-observation"),
        get: (recordId) => this.decisionIntelligence.getSourceObservation(recordId),
        record: (command) => this.decisionIntelligence.recordSourceObservation(command),
        now
      });
      const endpointLivenessRecord = await this.persistDiscoveryDecision<LivenessAssessment>({
        value: result.liveness,
        recordId: result.liveness.assessmentId,
        authorityRequestId: internalAuthorityRequestId(request.id, "discovery-endpoint-liveness"),
        get: (recordId) => this.decisionIntelligence.getLivenessAssessment(recordId),
        record: (command) => this.decisionIntelligence.recordLivenessAssessment(command),
        now
      });

      const products = new ProductRepositories(this.store);
      const postingSummaries: Record<string, unknown>[] = [];
      const newCandidates: DedupeCandidate[] = [];
      for (const posting of result.parseResult?.postings ?? []) {
        const derived = deriveDiscoveryPosting(posting, result.observation);
        const observationRecord = await this.persistDiscoveryDecision<SourceObservation>({
          value: derived.observation,
          recordId: derived.observation.observationId,
          authorityRequestId: internalAuthorityRequestId(request.id, `discovery-observation:${posting.postingId}`),
          get: (recordId) => this.decisionIntelligence.getSourceObservation(recordId),
          record: (command) => this.decisionIntelligence.recordSourceObservation(command),
          now
        });
        const livenessRecord = await this.persistDiscoveryDecision<LivenessAssessment>({
          value: derived.liveness,
          recordId: derived.liveness.assessmentId,
          authorityRequestId: internalAuthorityRequestId(request.id, `discovery-liveness:${posting.postingId}`),
          get: (recordId) => this.decisionIntelligence.getLivenessAssessment(recordId),
          record: (command) => this.decisionIntelligence.recordLivenessAssessment(command),
          now
        });
        const truthRecord = await this.persistDiscoveryDecision<OpportunityTruthRecord>({
          value: derived.truth,
          recordId: derived.truth.truthRecordId,
          authorityRequestId: internalAuthorityRequestId(request.id, `discovery-truth:${posting.postingId}`),
          get: (recordId) => this.decisionIntelligence.getOpportunityTruth(recordId),
          record: (command) => this.decisionIntelligence.recordOpportunityTruth(command),
          now
        });
        const currentOpportunity = await products.opportunities.get(derived.opportunity.opportunityId, true);
        const opportunityRecord = await products.opportunities.put({
          value: derived.opportunity,
          expectedVersion: currentOpportunity?.version ?? 0,
          operationId: internalAuthorityRequestId(request.id, `discovery-opportunity:${posting.postingId}`),
          now,
          authority: {
            requestId: request.id,
            requestHash,
            operation: request.operation
          },
          audit: {
            sourceObservationId: derived.observation.observationId,
            truthRecordId: derived.truth.truthRecordId,
            livenessAssessmentId: derived.liveness.assessmentId,
            grantDigest: storedGrant.grantDigest
          }
        });
        postingSummaries.push({
          opportunity: recordSummary(opportunityRecord),
          observation: recordSummary(observationRecord),
          liveness: recordSummary(livenessRecord),
          truth: recordSummary(truthRecord)
        });
        newCandidates.push(derived.dedupeCandidate);
      }

      let dedupeRecord: unknown = null;
      if (newCandidates.length > 0) {
        const observations = await this.decisionIntelligence.listSourceObservations();
        const latestObservationBySourceKey = new Map<string, SourceObservation>();
        for (const observationRecord of observations) {
          const current = latestObservationBySourceKey.get(observationRecord.value.sourceKey);
          if (!current || observationRecord.value.observedAt > current.observedAt) {
            latestObservationBySourceKey.set(observationRecord.value.sourceKey, observationRecord.value);
          }
        }
        const persistedCandidates = (await products.opportunities.list())
          .flatMap((opportunityRecord): DedupeCandidate[] => {
            const opportunity = opportunityRecord.value;
            if (opportunity.source === "manual") return [];
            const observation = latestObservationBySourceKey.get(`${opportunity.source}:${opportunity.sourceId}`);
            return observation
              ? [dedupeCandidateForOpportunity(opportunity, observation.observationId)]
              : [];
          })
          .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
        const selected = new Map(newCandidates.map((candidate) => [candidate.candidateId, candidate]));
        for (const candidate of persistedCandidates) {
          if (selected.size >= MAX_INCREMENTAL_DEDUPE_CANDIDATES) break;
          if (newCandidates.some((anchor) => likelyDedupeNeighbor(anchor, candidate))) {
            selected.set(candidate.candidateId, candidate);
          }
        }
        const dedupe = deduplicateCandidates([...selected.values()]);
        dedupeRecord = await this.persistDiscoveryDecision<DedupeResult>({
          value: dedupe,
          recordId: dedupe.resultId,
          authorityRequestId: internalAuthorityRequestId(request.id, "discovery-dedupe"),
          get: (recordId) => this.decisionIntelligence.getDedupeResult(recordId),
          record: (command) => this.decisionIntelligence.recordDedupeResult(command),
          now
        });
      }

      const responseCore = {
        providerId,
        grantId,
        grantDigest: storedGrant.grantDigest,
        endpointObservation: recordSummary(endpointObservationRecord),
        endpointLiveness: recordSummary(endpointLivenessRecord),
        postings: postingSummaries,
        dedupe: dedupeRecord === null ? null : recordSummary(dedupeRecord),
        rejectionCount: result.parseResult?.rejections.length ?? 0
      };
      const response = boundedAuthorityResponse({
        ...responseCore,
        runHash: sha256(stableStringify(responseCore))
      }, "Discovery run response");
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }

    if (request.operation === "credential-export-artifact") {
      if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
      const payload = exactObjectPayload(request.payload, ["exportedAt", "passportId"]);
      const passportId = requiredString(payload["passportId"], "Credential passport id");
      const exportedAt = canonicalDate(payload["exportedAt"], "Credential export time");
      const storedPassport = await this.decisionIntelligence.getCredentialPassport(passportId);
      if (!storedPassport) throw new Error(`Credential passport was not found: ${passportId}`);
      const originalManifest = await this.credentialOriginalManifest(storedPassport.value);
      const original = this.artifactVault.read(originalManifest);
      let exportBytes: Uint8Array | null = null;
      let packageHash: string;
      let exportManifest: ArtifactManifest;
      try {
        const generated = createCredentialPassportExport(storedPassport.value, original, exportedAt);
        exportBytes = generated.bytes;
        packageHash = generated.value.checksums.package;
        exportManifest = this.artifactVault.store(exportBytes).manifest;
      } finally {
        original.fill(0);
        exportBytes?.fill(0);
      }
      const artifactEventId = eventIdForRequest(
        internalAuthorityRequestId(request.id, "credential-export-artifact-manifest")
      );
      await this.ensureInternalArtifactManifest(exportManifest!, artifactEventId, now, {
        credentialPassportId: passportId,
        packageHash: packageHash!
      });
      const response = {
        record: {
          domain: storedPassport.domain,
          recordId: storedPassport.recordId,
          version: storedPassport.version,
          valueHash: storedPassport.valueHash,
          recordedAt: storedPassport.recordedAt
        },
        packageHash: packageHash!,
        artifact: exportManifest!
      };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return boundedAuthorityResponse(response, "Credential passport export");
    }

    if (request.operation === "artifact-export") {
      const payload = exactObjectPayload(request.payload, ["manifest", "outputPath"]);
      const response = this.exportArtifactToFile(payload["manifest"], payload["outputPath"]);
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }

    if (request.operation === "taxonomy-snapshot-import-artifact") {
      const payload = exactObjectPayload(request.payload, ["expectedVersion", "manifest"]);
      const manifest = payload["manifest"] as ArtifactManifest;
      const snapshot = this.readArtifactJson<TaxonomySnapshot>(
        manifest,
        "Taxonomy snapshot artifact",
        MAX_TAXONOMY_ARTIFACT_BYTES
      );
      assertSchema("taxonomy-snapshot", snapshot);
      const validation = validateTaxonomySnapshot(snapshot);
      if (!validation.valid) {
        throw new Error(`Taxonomy snapshot artifact is invalid: ${validation.errors.join(", ")}`);
      }
      const stored = await this.decisionIntelligence.recordTaxonomySnapshot({
        value: snapshot,
        expectedVersion: requiredVersion(payload["expectedVersion"]),
        authorityRequestId: internalAuthorityRequestId(request.id, "taxonomy-snapshot-record"),
        now
      });
      const response = {
        record: {
          domain: stored.domain,
          recordId: stored.recordId,
          version: stored.version,
          valueHash: stored.valueHash,
          recordedAt: stored.recordedAt
        },
        snapshot: {
          snapshotId: snapshot.snapshotId,
          source: snapshot.source,
          version: snapshot.version,
          conceptCount: snapshot.conceptCount,
          contentHash: snapshot.contentHash,
          provenanceHash: snapshot.provenanceHash
        },
        artifact: manifest
      };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }

    if (request.operation === "credential-import-artifact") {
      if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
      const payload = exactObjectPayload(request.payload, [
        "expectedSubjectId",
        "expectedVersion",
        "format",
        "importedAt",
        "manifest"
      ]);
      const manifest = payload["manifest"] as ArtifactManifest;
      assertArtifactManifest(manifest);
      assertSchema("artifact-manifest", manifest);
      const format = credentialInputFormat(payload["format"]);
      const expectedSubjectId = payload["expectedSubjectId"];
      if (expectedSubjectId !== null && (typeof expectedSubjectId !== "string" || expectedSubjectId.trim().length === 0)) {
        throw new Error("Expected credential subject id must be null or a non-empty string");
      }
      const plaintext = this.artifactVault.read(manifest);
      let imported: Awaited<ReturnType<typeof importCredential>>;
      try {
        imported = await importCredential(
          { content: plaintext, format },
          {
            cryptoVerifier: createCredentialCryptoVerifier({
              allowedAlgorithms: ["RS256", "PS256", "ES256", "EdDSA"]
            }),
            documentLoader: createLocalCredentialDocumentLoader()
          },
          {
            now: canonicalDate(payload["importedAt"], "Credential import time"),
            allowedAlgorithms: ["RS256", "PS256", "ES256", "EdDSA"],
            ...(expectedSubjectId === null ? {} : { expectedSubjectId })
          }
        );
      } finally {
        plaintext.fill(0);
      }
      if (
        imported.entry.original.hash !== manifest.contentHash
        || imported.entry.original.byteLength !== manifest.sizeBytes
      ) {
        throw new Error("Credential passport original is not bound to the encrypted artifact manifest");
      }
      const stored = await this.decisionIntelligence.recordCredentialPassport({
        value: imported.entry,
        expectedVersion: requiredVersion(payload["expectedVersion"]),
        authorityRequestId: internalAuthorityRequestId(request.id, "credential-passport-record"),
        now
      });
      const response = {
        record: {
          domain: stored.domain,
          recordId: stored.recordId,
          version: stored.version,
          valueHash: stored.valueHash,
          recordedAt: stored.recordedAt
        },
        passport: {
          passportEntryId: imported.entry.passportEntryId,
          canonicalCredentialHash: imported.entry.canonicalCredentialHash,
          summary: imported.entry.summary,
          verification: imported.entry.verification
        },
        artifact: manifest
      };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }

    const decisionRecordPayload = (): Record<string, unknown> =>
      exactObjectPayload(request.payload, ["expectedVersion", "value"]);
    switch (request.operation) {
      case "source-observation-record": {
        const payload = decisionRecordPayload();
        assertInlineAuthorityValue(payload["value"]);
        return this.decisionIntelligence.recordSourceObservation({
          value: payload["value"] as SourceObservation,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          authorityRequestId: request.id,
          now
        });
      }
      case "opportunity-truth-record": {
        const payload = decisionRecordPayload();
        assertInlineAuthorityValue(payload["value"]);
        return this.decisionIntelligence.recordOpportunityTruth({
          value: payload["value"] as OpportunityTruthRecord,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          authorityRequestId: request.id,
          now
        });
      }
      case "liveness-assessment-record": {
        const payload = decisionRecordPayload();
        assertInlineAuthorityValue(payload["value"]);
        return this.decisionIntelligence.recordLivenessAssessment({
          value: payload["value"] as LivenessAssessment,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          authorityRequestId: request.id,
          now
        });
      }
      case "dedupe-result-record": {
        const payload = decisionRecordPayload();
        assertInlineAuthorityValue(payload["value"]);
        return this.decisionIntelligence.recordDedupeResult({
          value: payload["value"] as DedupeResult,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          authorityRequestId: request.id,
          now
        });
      }
      case "taxonomy-snapshot-record": {
        throw new Error("Taxonomy snapshots must use taxonomy-snapshot-import-artifact");
      }
      case "taxonomy-mapping-record": {
        const payload = decisionRecordPayload();
        assertInlineAuthorityValue(payload["value"]);
        return this.decisionIntelligence.recordTaxonomyMappingSet({
          value: payload["value"] as TaxonomyMappingSet,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          authorityRequestId: request.id,
          now
        });
      }
      case "assurance-case-record": {
        const payload = decisionRecordPayload();
        assertInlineAuthorityValue(payload["value"]);
        return this.decisionIntelligence.recordCareerAssuranceCase({
          value: payload["value"] as CareerAssuranceCase,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          authorityRequestId: request.id,
          now
        });
      }
      case "credential-passport-record": {
        throw new Error("Credential passports must use credential-import-artifact");
      }
      case "credential-mapping-record": {
        const payload = decisionRecordPayload();
        assertInlineAuthorityValue(payload["value"]);
        return this.decisionIntelligence.recordCredentialMappingPlan({
          value: payload["value"] as CredentialMappingPlan,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          authorityRequestId: request.id,
          now
        });
      }
      case "campaign-record": {
        const payload = decisionRecordPayload();
        const record = await new ProductRepositories(this.store).campaigns.put({
          value: payload["value"] as CampaignRecord,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          operationId: request.id,
          eventId,
          now,
          authority: { requestId: request.id, requestHash, operation: request.operation }
        });
        this.recordPersistedResponse(request, requestHash, eventId, record, now);
        return record;
      }
      case "outcome-record": {
        const payload = decisionRecordPayload();
        const record = await new ProductRepositories(this.store).outcomes.put({
          value: payload["value"] as CareerOutcomeEvent,
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          operationId: request.id,
          eventId,
          now,
          authority: { requestId: request.id, requestHash, operation: request.operation }
        });
        this.recordPersistedResponse(request, requestHash, eventId, record, now);
        return record;
      }
      case "campaign-archive":
      case "outcome-archive": {
        const payload = exactObjectPayload(request.payload, ["expectedVersion", "recordId"]);
        const domain = request.operation === "campaign-archive" ? "campaigns" : "outcomes";
        const record = await new ProductRepositories(this.store).repository(domain).archive({
          recordId: requiredString(payload["recordId"], `${domain} record id`),
          expectedVersion: requiredVersion(payload["expectedVersion"]),
          operationId: request.id,
          eventId,
          now,
          authority: { requestId: request.id, requestHash, operation: request.operation }
        });
        this.recordPersistedResponse(request, requestHash, eventId, record, now);
        return record;
      }
    }

    if (request.operation === "daemon-stop") {
      objectPayload(request.payload);
      const response = { status: "shutdown-authorized", requestedAt: now.toISOString() };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "auto-apply-kill") {
      const payload = objectPayload(request.payload);
      const reason = typeof payload["reason"] === "string" ? payload["reason"] : "operator kill command";
      return this.mutateConfig(
        request,
        requestHash,
        eventId,
        (config) => engageKillSwitch(config, "authenticated-local-operator", reason, now),
        now
      );
    }
    if (request.operation === "artifact-import") {
      if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
      const payload = objectPayload(request.payload);
      const sourcePath = requiredString(payload["sourcePath"], "Artifact source path");
      if (!path.isAbsolute(sourcePath)) throw new Error("Artifact source path must be absolute");
      const stored = this.artifactVault.storeFile(sourcePath);
      const response = stored.manifest;
      await this.repository.saveArtifactManifest({
        manifest: response,
        eventId,
        occurredAt: now,
        metadata: this.authorityMetadata(request, requestHash, response)
      });
      this.recordPersistedResponse(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "profile-import-plan") {
      if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
      const payload = objectPayload(request.payload);
      const manifest = payload["manifest"] as ArtifactManifest;
      const format = payload["format"] as ProfileImportFormat;
      assertArtifactManifest(manifest);
      assertSchema("artifact-manifest", manifest);
      if (!PROFILE_IMPORT_FORMATS.includes(format)) throw new Error("Profile import format is invalid");
      const plaintext = this.artifactVault.read(manifest);
      let plan: ProfileImportPlan;
      try {
        plan = createProfileImportPlan(manifest, await parseProfileArtifact(plaintext, format), now);
      } finally {
        plaintext.fill(0);
      }
      await this.recordCommand(request, requestHash, eventId, plan, now);
      return plan;
    }
    if (request.operation === "profile-import-apply") {
      const payload = objectPayload(request.payload);
      const planHash = requiredString(payload["planHash"], "Profile import plan hash");
      const plan = await this.findProfileImportPlan(planHash);
      if (!plan) throw new Error("Approved profile import plan was not found");
      if (plan.planHash !== planHash) throw new Error("Profile import plan hash does not match approval");
      const twin = careerTwinFromImportPlan(plan);
      const profiles = new ProductRepositories(this.store).profiles;
      const existing = await profiles.get(twin.twinId, true);
      if (existing) {
        if (existing.status !== "active" || existing.valueHash !== sha256(stableStringify(twin))) {
          throw new Error("Existing imported profile is not bound to the approved plan");
        }
        await this.recordCommand(request, requestHash, eventId, existing, now);
        return existing;
      }
      const record = await profiles.put({
        value: twin,
        expectedVersion: 0,
        operationId: request.id,
        eventId,
        now,
        authority: { requestId: request.id, requestHash, operation: request.operation }
      });
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (request.operation === "onboarding-start") {
      const payload = objectPayload(request.payload);
      const initializationMode = payload["initializationMode"];
      if (initializationMode !== "demo" && initializationMode !== "profile") {
        throw new Error("Onboarding start requires demo or profile initialization mode");
      }
      const existing = await this.repository.loadOnboardingSession();
      if (existing) {
        if (existing.initializationMode !== initializationMode) {
          throw new Error(`Onboarding mode is locked to ${existing.initializationMode}`);
        }
        await this.recordCommand(request, requestHash, eventId, existing, now);
        return existing;
      }
      const session = createOnboardingSession({
        sessionId: uuidForRequest(request.id),
        createdAt: now.toISOString(),
        initializationMode
      });
      return this.saveOnboardingResponse(request, requestHash, eventId, session, now);
    }
    if (
      request.operation === "onboarding-complete-step"
      || request.operation === "onboarding-fail"
      || request.operation === "onboarding-cancel"
      || request.operation === "onboarding-resume"
    ) {
      const payload = objectPayload(request.payload);
      const current = await this.repository.loadOnboardingSession();
      if (!current) throw new Error("Onboarding has not been started");
      const step = requiredString(payload["step"], "Onboarding step") as ActionableOnboardingStep;
      const expectedVersion = requiredVersion(payload["expectedVersion"]);
      const operationId = uuidForRequest(request.id);
      const occurredAt = now.toISOString();
      let next: OnboardingSession;
      if (request.operation === "onboarding-complete-step") {
        const result = payload["result"] as OnboardingStepResultInput;
        await this.assertOnboardingStepPrerequisites(current, step, result);
        next = completeOnboardingStep(current, { operationId, expectedVersion, step, occurredAt, result });
      } else if (request.operation === "onboarding-resume") {
        next = resumeOnboarding(current, { operationId, expectedVersion, step, occurredAt });
      } else {
        const reasonCode = requiredString(payload["reasonCode"], "Onboarding reason code");
        const resultPointer = requiredString(payload["resultPointer"], "Onboarding result pointer") as RedactedResultPointer;
        const command = { operationId, expectedVersion, step, occurredAt, reasonCode, resultPointer };
        next = request.operation === "onboarding-fail"
          ? failOnboarding(current, command)
          : cancelOnboarding(current, command);
      }
      return this.saveOnboardingResponse(request, requestHash, eventId, next, now);
    }
    if (request.operation === "domain-put") {
      const payload = objectPayload(request.payload);
      const domain = productDomain(payload["domain"]);
      const value = payload["value"];
      const expectedVersion = requiredVersion(payload["expectedVersion"]);
      if (domain === "applications") {
        throw new Error("Application records must use tracker lifecycle operations");
      }
      if (domain === "campaigns" || domain === "outcomes") {
        throw new Error(`${domain} records must use dedicated authority operations`);
      }
      if (domain === "profiles" && typeof value === "object" && value !== null) {
        const twinId = (value as { twinId?: unknown }).twinId;
        if (typeof twinId === "string" && twinId.startsWith("LOCAL-TWIN-")) {
          throw new Error("Imported local profile identifiers are reserved for profile-import-apply");
        }
      }
      if (domain === "documents") {
        const claimGraph = payload["claimGraph"] as ClaimGraph;
        if (typeof claimGraph !== "object" || claimGraph === null) {
          throw new Error("Document writes require a claim graph");
        }
        assertSchema("claim-graph", claimGraph);
        const documentValue = value as DocumentAst | DocumentAstV2;
        const validation = "schemaVersion" in documentValue && documentValue.schemaVersion === 2
          ? validateDocumentAstV2(documentValue, claimGraph, now)
          : validateDocumentAst(documentValue as DocumentAst, claimGraph, now);
        if (!validation.valid) throw new Error(`Document AST validation failed: ${validation.reasons.join(", ")}`);
      }
      const repository = new ProductRepositories(this.store).repository(domain);
      const record = await repository.put({
        value,
        expectedVersion,
        operationId: request.id,
        eventId,
        now,
        authority: { requestId: request.id, requestHash, operation: request.operation }
      });
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (
      request.operation === "tracker-create"
      || request.operation === "tracker-approve"
      || request.operation === "tracker-submit"
      || request.operation === "tracker-block"
      || request.operation === "tracker-confirm"
    ) {
      const payload = objectPayload(request.payload);
      const tracker = new ApplicationTracker(
        new ProductRepositories(this.store),
        await this.repository.listTrustedApprovers(),
        await this.repository.listTrustedCollectors()
      );
      const context = {
        operationId: request.id,
        eventId,
        authority: { requestId: request.id, requestHash, operation: request.operation },
        now
      };
      let record: VersionedDomainRecord<unknown>;
      if (request.operation === "tracker-create") {
        const input = payload["input"] as Omit<ApplicationAttemptInput, "now">;
        if (typeof input !== "object" || input === null) throw new Error("Tracker create input is required");
        record = await tracker.create(input, context) as VersionedDomainRecord<unknown>;
      } else {
        const attemptId = requiredString(payload["attemptId"], "Application attempt id");
        const expectedVersion = requiredVersion(payload["expectedVersion"]);
        if (request.operation === "tracker-approve") {
          record = await tracker.approve(
            attemptId,
            expectedVersion,
            payload["approval"] as ApprovalReference,
            context
          ) as VersionedDomainRecord<unknown>;
        } else if (request.operation === "tracker-submit") {
          record = await tracker.markSubmitted(attemptId, expectedVersion, context) as VersionedDomainRecord<unknown>;
        } else if (request.operation === "tracker-block") {
          record = await tracker.block(
            attemptId,
            expectedVersion,
            requiredString(payload["blocker"], "Application blocker"),
            context
          ) as VersionedDomainRecord<unknown>;
        } else {
          record = await tracker.confirm(
            attemptId,
            expectedVersion,
            payload["proof"] as SubmissionProof,
            context
          ) as VersionedDomainRecord<unknown>;
        }
      }
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (request.operation === "domain-archive") {
      const payload = objectPayload(request.payload);
      const domain = productDomain(payload["domain"]);
      if (domain === "applications") {
        throw new Error("Application records must use tracker lifecycle operations");
      }
      if (domain === "campaigns" || domain === "outcomes") {
        throw new Error(`${domain} records must use dedicated authority operations`);
      }
      const recordId = requiredString(payload["recordId"], "Domain record id");
      const expectedVersion = requiredVersion(payload["expectedVersion"]);
      const repository = new ProductRepositories(this.store).repository(domain);
      const current = await repository.get(recordId, true);
      if (current?.status === "archived") {
        if (current.version !== expectedVersion) {
          throw new Error(`Domain version conflict, expected ${expectedVersion}, current ${current.version}`);
        }
        await this.recordCommand(request, requestHash, eventId, current, now);
        return current;
      }
      const record = await repository.archive({
        recordId,
        expectedVersion,
        operationId: request.id,
        eventId,
        now,
        authority: { requestId: request.id, requestHash, operation: request.operation }
      });
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (request.operation === "auto-apply-rearm") {
      objectPayload(request.payload);
      return this.mutateConfig(request, requestHash, eventId, rearmAutoApplyAuthorized, now);
    }
    if (request.operation === "auto-apply-enable") {
      const payload = objectPayload(request.payload);
      const mode = payload["mode"];
      if (mode !== "draft-only" && mode !== "auto") throw new Error("Enable mode must be draft-only or auto");
      return this.mutateConfig(request, requestHash, eventId, (config) => enableAutoApply(config, mode), now);
    }
    if (request.operation === "auto-apply-evaluate") {
      const payload = objectPayload(request.payload);
      const packet = payload["packet"] as ApplicationPacket;
      const claimGraph = payload["claimGraph"] as ClaimGraph;
      const reversibilityTag = payload["reversibilityTag"] as ReversibilityTag;
      const adapterId = payload["adapterId"];
      if (typeof packet !== "object" || packet === null || typeof claimGraph !== "object" || claimGraph === null) {
        throw new Error("Auto apply evaluation requires packet and claim graph objects");
      }
      assertSchema("application-packet", packet);
      assertSchema("claim-graph", claimGraph);
      if (typeof adapterId !== "string") throw new Error("Auto apply evaluation requires an adapter id");
      if (!(["R0", "R1", "R2", "R3", "R4"] as const).includes(reversibilityTag)) {
        throw new Error("Auto apply evaluation requires a valid reversibility tag");
      }
      const config = await this.repository.loadAutoApplyConfig();
      const actionHex = sha256(request.id).slice("sha256:".length);
      const actionUuid = `${actionHex.slice(0, 8)}-${actionHex.slice(8, 12)}-${actionHex.slice(12, 16)}-${actionHex.slice(16, 20)}-${actionHex.slice(20, 32)}`;
      const actionId = `A-${now.getUTCFullYear()}-${actionUuid}`;
      const approvalReference = payload["approvalReference"] as ApprovalReference | undefined;
      const riskSignals = payload["riskSignals"] as AutomationRiskSignals | undefined;
      const highStakesFlags = payload["highStakesFlags"] as HighStakesFlags | undefined;
      let decision: AutoApplyDecision;
      try {
        assertExecutableAdapter(adapterId, config.adapterAllowlist, claimGraph.profileScope);
        decision = decideAutoApply({
          config,
          packet,
          claimGraph,
          reversibilityTag,
          adapterId,
          ...(approvalReference ? { approvalReference } : {}),
          trustedApprovers: await this.repository.listTrustedApprovers(),
          ...(riskSignals ? { riskSignals } : {}),
          ...(highStakesFlags ? { highStakesFlags } : {}),
          documentRoot: PACKAGE_ROOT,
          authoritativeLedgerEntries: await this.repository.readLedger(),
          actionId,
          now
        });
      } catch (error) {
        decision = {
          allowed: false,
          blockedBy: "adapter-authority-denied",
          reasons: [error instanceof Error ? error.message : String(error)],
          requiredApprovals: [],
          ledgerActionId: actionId,
          confirmationEvidenceRequired: true
        };
      }
      const entry: ActionLedgerEntry = {
        actionId,
        timestamp: now.toISOString(),
        mode: "/auto-apply-config",
        opportunityId: packet.opportunityId,
        reversibilityTag,
        evidenceGatePassed: decision.allowed || decision.blockedBy === "approval-required",
        approvalRequired: true,
        approvalReceived: approvalReference !== undefined,
        highStakesGatePassed: !highStakesFlags || !Object.values(highStakesFlags).some((value) => value === true),
        result: decision.allowed ? "decision_allowed" : "blocked",
        ...(decision.blockedBy ? { blockedBy: decision.blockedBy } : {})
      };
      await this.recordDecisionCommand(request, requestHash, eventId, decision, entry, now);
      return decision;
    }
    if (request.operation === "legacy-import-apply") {
      const payload = objectPayload(request.payload);
      const planHash = payload["planHash"];
      if (typeof planHash !== "string") throw new Error("Legacy import apply requires a plan hash");
      const plan = planLegacyImport(this.runtimeRoot);
      if (plan.planHash !== planHash) throw new Error("Legacy import plan changed after approval");
      const digest = planHash.slice("sha256:".length);
      const preImportHead = await this.store.chainHead();
      const stateBinding = `${preImportHead.eventCount}-${preImportHead.headHash.slice("sha256:".length)}`;
      const backupPath = path.join(
        this.runtimeRoot,
        "backups",
        `pre-import-${digest}-${stateBinding}.vocationbak`
      );
      const journalPath = path.join(
        this.runtimeRoot,
        "operations",
        `legacy-import-${digest}-${stateBinding}.json`
      );
      const rollbackPassphrase = await getOrCreateCredential(
        this.credentials,
        CREDENTIAL_ACCOUNTS.rollbackBackupSecret,
        32
      );
      const journal: StorageOperationJournal = {
        version: 1,
        operationId: `IMPORT-${digest.slice(0, 32)}`,
        operation: "legacy-import",
        phase: "prepared",
        targetPath: this.store.path(),
        rollbackPath: backupPath,
        expectedHash: planHash,
        updatedAt: now.toISOString()
      };
      writeOperationJournal(journalPath, journal);
      if (!existsSync(backupPath)) {
        await createEncryptedBackup(this.store, backupPath, rollbackPassphrase, { now });
      } else {
        const existingBackup = inspectEncryptedBackup(backupPath, rollbackPassphrase);
        if (
          existingBackup.databaseId !== await this.store.databaseId()
          || existingBackup.eventCount !== preImportHead.eventCount
          || existingBackup.eventChainHead !== preImportHead.headHash
        ) {
          throw new Error("Existing rollback backup does not match the current pre-import event state");
        }
      }
      journal.phase = "backup_complete";
      journal.updatedAt = new Date(now.getTime() + 1).toISOString();
      writeOperationJournal(journalPath, journal);
      const importResult = await applyLegacyImport(this.store, plan, planHash, now);
      const response = { ...importResult, rollbackBackupPath: backupPath, journalPath };
      await this.recordCommand(request, requestHash, eventId, response, now);
      journal.phase = "complete";
      journal.updatedAt = new Date(now.getTime() + 2).toISOString();
      writeOperationJournal(journalPath, journal);
      return response;
    }
    if (request.operation === "checkpoint-create") {
      objectPayload(request.payload);
      const response = await createSignedCheckpoint(
        this.store,
        this.credentials,
        now,
        checkpointIdForRequest(request.id)
      );
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "approver-register") {
      const payload = objectPayload(request.payload);
      const approvedBy = payload["approvedBy"];
      const keyId = payload["keyId"];
      const publicKeyPem = payload["publicKeyPem"];
      if (typeof approvedBy !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(approvedBy)) {
        throw new Error("Approver identity is invalid");
      }
      if (typeof keyId !== "string" || !/^KEY-[A-Za-z0-9-]{8,100}$/.test(keyId)) {
        throw new Error("Approver key id is invalid");
      }
      if (typeof publicKeyPem !== "string") throw new Error("Approver public key is required");
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Approver key must be Ed25519");
      const approver: TrustedApprover = { approvedBy, keyId, publicKeyPem };
      const existing = (await this.repository.listTrustedApprovers()).find((candidate) => candidate.keyId === keyId);
      if (existing && stableStringify(existing) !== stableStringify(approver)) {
        throw new Error("Approver key id is already registered with different material");
      }
      const response = { action: "registered" as const, approver };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "approver-revoke") {
      const payload = objectPayload(request.payload);
      const keyId = payload["keyId"];
      if (typeof keyId !== "string" || !/^KEY-[A-Za-z0-9-]{8,100}$/.test(keyId)) {
        throw new Error("Approver key id is invalid");
      }
      const response = { action: "revoked" as const, keyId };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "collector-register") {
      const payload = objectPayload(request.payload);
      const collector = payload as unknown as TrustedCollector;
      assertSchema("trusted-collector", collector);
      const key = createPublicKey(collector.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Collector key must be Ed25519");
      const existing = (await this.repository.listTrustedCollectors())
        .find((candidate) => candidate.keyId === collector.keyId);
      if (existing && stableStringify(existing) !== stableStringify(collector)) {
        throw new Error("Collector key id is already registered with different material");
      }
      const response = { action: "registered" as const, collector };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "collector-revoke") {
      const payload = objectPayload(request.payload);
      const keyId = requiredString(payload["keyId"], "Collector key id");
      if (!/^KEY-[A-Z0-9-]{8,100}$/.test(keyId)) throw new Error("Collector key id is invalid");
      const response = { action: "revoked" as const, keyId };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    throw new Error(`Unsupported authority operation: ${request.operation}`);
  }
}
