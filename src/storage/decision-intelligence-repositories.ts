import { sha256, stableStringify } from "../hash.js";
import {
  assertSourceObservation,
  type SourceObservation
} from "../discovery/source-observation.js";
import {
  assertOpportunityTruthRecord,
  type OpportunityTruthRecord
} from "../discovery/opportunity-truth.js";
import {
  assertLivenessAssessment,
  type LivenessAssessment
} from "../discovery/liveness.js";
import { assertDedupeResult, type DedupeResult } from "../discovery/dedupe.js";
import {
  validateTaxonomySnapshot,
  type TaxonomySnapshot
} from "../taxonomy/snapshot.js";
import {
  validateTaxonomyMappingSet,
  type TaxonomyMappingSet
} from "../taxonomy/mapping.js";
import {
  evaluateCareerAssuranceCase,
  type CareerAssuranceCase
} from "../assurance/index.js";
import { assertCredentialContract } from "../credentials/schema.js";
import { computeCredentialMappingHash } from "../credentials/mapping.js";
import type {
  CredentialClaimMapping,
  CredentialPassportEntry
} from "../credentials/types.js";
import type {
  AuthorityReceipt,
  EncryptedEventStore,
  StoredEvent
} from "./encrypted-event-store.js";

export const DECISION_INTELLIGENCE_DOMAINS = [
  "source-observations",
  "opportunity-truth-records",
  "liveness-assessments",
  "dedupe-results",
  "taxonomy-snapshots",
  "taxonomy-mapping-sets",
  "career-assurance-cases",
  "credential-passport-records",
  "credential-mapping-plans"
] as const;

export type DecisionIntelligenceDomain = (typeof DECISION_INTELLIGENCE_DOMAINS)[number];
export type CredentialMappingPlan = CredentialClaimMapping;

export interface DecisionIntelligenceAuthorityBinding {
  requestId: string;
  requestHash: string;
  operation: string;
}

export interface DecisionIntelligenceRecord<T> {
  domain: DecisionIntelligenceDomain;
  recordId: string;
  version: number;
  value: T;
  valueHash: string;
  authority: DecisionIntelligenceAuthorityBinding;
  recordedAt: string;
}

export interface DecisionIntelligenceRecordCommand<T> {
  value: T;
  expectedVersion: number;
  authorityRequestId: string;
  now?: Date;
}

interface DomainDescriptor<T> {
  readonly domain: DecisionIntelligenceDomain;
  readonly recordOperation: string;
  readonly idOf: (value: T) => string;
  readonly validate: (value: T) => void;
}

interface EventAuthorityBinding extends DecisionIntelligenceAuthorityBinding {
  responseHash: string;
}

interface DecisionIntelligenceEventPayload<T> {
  record: DecisionIntelligenceRecord<T>;
  response: DecisionIntelligenceRecord<T>;
  metadata: {
    authority: EventAuthorityBinding;
  };
}

class MutationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const EVENT_SCHEMA_VERSION = 1;
const EVENT_TYPE = "decision-intelligence-record-put";
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID_PATTERN = /^REQ-[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return stableStringify(Object.keys(value).sort()) === stableStringify([...keys].sort());
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function assertAuthorityRequestId(value: string): void {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new Error("Decision intelligence authority request id is invalid");
  }
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Decision intelligence expected version must be a non-negative safe integer");
  }
}

function canonicalTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Decision intelligence operation time is invalid");
  }
  return value.toISOString();
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO date-time`);
  }
}

function assertCanonicalJson(value: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error("Decision intelligence record exceeds the JSON node limit");
    if (depth > MAX_JSON_DEPTH) throw new Error("Decision intelligence record exceeds the JSON depth limit");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Decision intelligence records require finite JSON numbers");
      return;
    }
    if (typeof current !== "object") {
      throw new Error("Decision intelligence records must contain only JSON-compatible values");
    }
    if (seen.has(current)) throw new Error("Decision intelligence records cannot contain circular values");
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getOwnPropertySymbols(current).length > 0) {
          throw new Error("Decision intelligence records cannot contain symbol properties");
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const elementKeys = Object.keys(descriptors).filter((key) => key !== "length");
        if (
          elementKeys.length !== current.length
          || elementKeys.some((key, index) => key !== String(index))
        ) throw new Error("Decision intelligence records cannot contain sparse or extended arrays");
        for (const key of elementKeys) {
          const descriptor = descriptors[key];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new Error("Decision intelligence records cannot contain array accessors");
          }
          visit(descriptor.value, depth + 1);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Decision intelligence records must contain only plain JSON objects");
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new Error("Decision intelligence records cannot contain symbol properties");
      }
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Decision intelligence records cannot contain accessors or hidden properties");
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      seen.delete(current);
    }
  };

  visit(value, 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone<T>(value: T): T {
  assertCanonicalJson(value);
  return deepFreeze(JSON.parse(stableStringify(value)) as T);
}

function aggregateType(domain: DecisionIntelligenceDomain): string {
  return `decision-${domain}`;
}

function deterministicEventId(requestId: string): string {
  return `EVT-CMD-${sha256(requestId).slice("sha256:".length)}`;
}

function canonicalRequestHash<T>(
  operation: string,
  expectedVersion: number,
  value: T
): string {
  return sha256(stableStringify({
    operation,
    payload: { expectedVersion, value }
  }));
}

function assertCredentialMappingPlan(value: CredentialMappingPlan): void {
  assertCredentialContract("credential-mapping", value);
  if (value.mappingHash !== computeCredentialMappingHash(value)) {
    throw new Error("Credential mapping plan hash is invalid");
  }
  if (value.requestedAutoApply && !value.requestedPublic) {
    throw new Error("Credential mapping plan automatic use requires public review");
  }
  if (value.status === "pending") {
    if (value.approval !== null || value.publiclyAssertable || value.allowedInAutoApply) {
      throw new Error("Pending credential mapping plans cannot carry approved permissions");
    }
    return;
  }
  if (value.approval === null) throw new Error("Approved credential mapping plans require an approval");
  const approvedAt = Date.parse(value.approval.approvedAt);
  const expiresAt = Date.parse(value.approval.expiresAt);
  if (
    !Number.isFinite(approvedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= approvedAt
    || expiresAt - approvedAt > 24 * 60 * 60_000
  ) throw new Error("Credential mapping plan approval window is invalid");
  if (
    value.approval.mappingHash !== value.mappingHash
    || value.publiclyAssertable !== value.approval.allowPublic
    || value.allowedInAutoApply !== value.approval.allowAutoApply
    || (value.approval.allowPublic && !value.requestedPublic)
    || (value.approval.allowAutoApply && (
      !value.requestedAutoApply
      || !value.requestedPublic
      || !value.approval.allowPublic
    ))
  ) {
    throw new Error("Credential mapping plan approval is not bound to its permissions");
  }
}

function assertCredentialPassport(value: CredentialPassportEntry): void {
  assertCredentialContract("credential-passport", value);
  if (value.canonicalCredentialHash !== sha256(stableStringify(value.credential))) {
    throw new Error("Credential passport canonical hash is invalid");
  }
  const expectedId = `CREDENTIAL-${value.original.hash.slice("sha256:".length).toUpperCase()}`;
  if (value.passportEntryId !== expectedId) {
    throw new Error("Credential passport id is not bound to its original artifact hash");
  }
  if (value.verification.eligibleForMapping && value.verification.overall !== "verified") {
    throw new Error("Credential passport mapping eligibility requires verified status");
  }
  if (value.verification.eligibleForMapping !== (value.verification.overall === "verified")) {
    throw new Error("Credential passport verification outcome and mapping eligibility are inconsistent");
  }
  const mandatoryChecks = [
    value.verification.schema,
    value.verification.signature,
    value.verification.issuer,
    value.verification.subject,
    value.verification.time
  ];
  if (
    value.verification.overall === "verified"
    && (
      mandatoryChecks.some((check) => check.status !== "pass")
      || !["pass", "not-applicable"].includes(value.verification.revocation.status)
      || !["pass", "not-applicable"].includes(value.verification.refresh.status)
    )
  ) throw new Error("Verified credential passport contains a non-verifying check");
  const mappingIds = new Set<string>();
  for (const mapping of value.mappings) {
    assertCredentialMappingPlan(mapping);
    if (mapping.status !== "approved" || mapping.approval === null) {
      throw new Error("Credential passport can contain only approved mappings");
    }
    if (mappingIds.has(mapping.mappingId)) throw new Error("Credential passport contains duplicate mappings");
    mappingIds.add(mapping.mappingId);
    if (
      mapping.credentialHash !== value.canonicalCredentialHash
      || mapping.credentialId !== value.summary.credentialId
    ) {
      throw new Error("Credential passport mapping is not bound to its credential");
    }
  }
}

function assertAssuranceCase(value: CareerAssuranceCase): void {
  const evaluation = evaluateCareerAssuranceCase(value, {
    now: new Date(value.createdAt),
    requireCertification: false
  });
  if (!evaluation.valid) {
    throw new Error(
      `Career assurance case integrity validation failed: ${evaluation.reasons.map((reason) => reason.code).join(", ")}`
    );
  }
}

const SOURCE_OBSERVATION_DESCRIPTOR: DomainDescriptor<SourceObservation> = {
  domain: "source-observations",
  recordOperation: "source-observation-record",
  idOf: (value) => value.observationId,
  validate: assertSourceObservation
};

const OPPORTUNITY_TRUTH_DESCRIPTOR: DomainDescriptor<OpportunityTruthRecord> = {
  domain: "opportunity-truth-records",
  recordOperation: "opportunity-truth-record",
  idOf: (value) => value.truthRecordId,
  validate: assertOpportunityTruthRecord
};

const LIVENESS_DESCRIPTOR: DomainDescriptor<LivenessAssessment> = {
  domain: "liveness-assessments",
  recordOperation: "liveness-assessment-record",
  idOf: (value) => value.assessmentId,
  validate: assertLivenessAssessment
};

const DEDUPE_DESCRIPTOR: DomainDescriptor<DedupeResult> = {
  domain: "dedupe-results",
  recordOperation: "dedupe-result-record",
  idOf: (value) => value.resultId,
  validate: assertDedupeResult
};

const TAXONOMY_SNAPSHOT_DESCRIPTOR: DomainDescriptor<TaxonomySnapshot> = {
  domain: "taxonomy-snapshots",
  recordOperation: "taxonomy-snapshot-record",
  idOf: (value) => value.snapshotId,
  validate: (value) => {
    const result = validateTaxonomySnapshot(value);
    if (!result.valid) throw new Error(`Taxonomy snapshot validation failed: ${result.errors.join("; ")}`);
  }
};

const TAXONOMY_MAPPING_DESCRIPTOR: DomainDescriptor<TaxonomyMappingSet> = {
  domain: "taxonomy-mapping-sets",
  recordOperation: "taxonomy-mapping-record",
  idOf: (value) => value.mappingSetId,
  validate: (value) => {
    const result = validateTaxonomyMappingSet(value);
    if (!result.valid) throw new Error(`Taxonomy mapping set validation failed: ${result.errors.join("; ")}`);
  }
};

const ASSURANCE_DESCRIPTOR: DomainDescriptor<CareerAssuranceCase> = {
  domain: "career-assurance-cases",
  recordOperation: "assurance-case-record",
  idOf: (value) => value.caseId,
  validate: assertAssuranceCase
};

const CREDENTIAL_PASSPORT_DESCRIPTOR: DomainDescriptor<CredentialPassportEntry> = {
  domain: "credential-passport-records",
  recordOperation: "credential-passport-record",
  idOf: (value) => value.passportEntryId,
  validate: assertCredentialPassport
};

const CREDENTIAL_MAPPING_DESCRIPTOR: DomainDescriptor<CredentialMappingPlan> = {
  domain: "credential-mapping-plans",
  recordOperation: "credential-mapping-record",
  idOf: (value) => value.mappingId,
  validate: assertCredentialMappingPlan
};

export class DecisionIntelligenceRepositories {
  private readonly mutations = new MutationCoordinator();

  public constructor(private readonly store: EncryptedEventStore) {}

  private verifyRecord<T>(
    descriptor: DomainDescriptor<T>,
    record: DecisionIntelligenceRecord<T>
  ): void {
    if (!isRecord(record) || !hasExactKeys(record as unknown as Record<string, unknown>, [
      "domain",
      "recordId",
      "version",
      "value",
      "valueHash",
      "authority",
      "recordedAt"
    ])) throw new Error("Decision intelligence record envelope is malformed");
    if (record.domain !== descriptor.domain) throw new Error("Decision intelligence record belongs to another domain");
    assertIdentifier(record.recordId, "Decision intelligence record id");
    if (!Number.isSafeInteger(record.version) || record.version < 1) {
      throw new Error("Decision intelligence record version is invalid");
    }
    assertCanonicalTimestamp(record.recordedAt, "Decision intelligence record time");
    assertCanonicalJson(record.value);
    descriptor.validate(record.value);
    if (descriptor.idOf(record.value) !== record.recordId) {
      throw new Error("Decision intelligence record id is not bound to its value");
    }
    if (!HASH_PATTERN.test(record.valueHash) || record.valueHash !== sha256(stableStringify(record.value))) {
      throw new Error("Decision intelligence record value hash is invalid");
    }
    if (!isRecord(record.authority) || !hasExactKeys(record.authority as unknown as Record<string, unknown>, [
      "requestId",
      "requestHash",
      "operation"
    ])) throw new Error("Decision intelligence authority binding is malformed");
    assertAuthorityRequestId(record.authority.requestId);
    const expectedOperation = descriptor.recordOperation;
    if (record.authority.operation !== expectedOperation) {
      throw new Error("Decision intelligence authority operation is invalid");
    }
    const expectedRequestHash = canonicalRequestHash(
      expectedOperation,
      record.version - 1,
      record.value
    );
    if (record.authority.requestHash !== expectedRequestHash) {
      throw new Error("Decision intelligence authority request hash is invalid");
    }
  }

  private recordFromEvent<T>(
    descriptor: DomainDescriptor<T>,
    event: StoredEvent<DecisionIntelligenceEventPayload<T>>
  ): DecisionIntelligenceRecord<T> {
    if (
      event.aggregateType !== aggregateType(descriptor.domain)
      || event.eventType !== EVENT_TYPE
      || event.schemaVersion !== EVENT_SCHEMA_VERSION
    ) throw new Error("Decision intelligence event contract is invalid");
    if (!isRecord(event.payload) || !hasExactKeys(event.payload, ["record", "response", "metadata"])) {
      throw new Error("Decision intelligence event payload is malformed");
    }
    const record = event.payload.record;
    this.verifyRecord(descriptor, record);
    if (event.aggregateId !== record.recordId || event.occurredAt !== record.recordedAt) {
      throw new Error("Decision intelligence event is not bound to its record aggregate");
    }
    if (event.eventId !== deterministicEventId(record.authority.requestId)) {
      throw new Error("Decision intelligence event id is not bound to its authority request");
    }
    if (stableStringify(event.payload.response) !== stableStringify(record)) {
      throw new Error("Decision intelligence event response is not bound to its record");
    }
    if (
      !isRecord(event.payload.metadata)
      || !hasExactKeys(event.payload.metadata, ["authority"])
      || !isRecord(event.payload.metadata.authority)
      || !hasExactKeys(event.payload.metadata.authority, ["requestId", "requestHash", "operation", "responseHash"])
    ) throw new Error("Decision intelligence event authority metadata is malformed");
    const authority = event.payload.metadata.authority as unknown as EventAuthorityBinding;
    if (
      authority.requestId !== record.authority.requestId
      || authority.requestHash !== record.authority.requestHash
      || authority.operation !== record.authority.operation
      || authority.responseHash !== sha256(stableStringify(record))
    ) throw new Error("Decision intelligence event authority binding is invalid");
    return deepFreeze(record);
  }

  private recordsFromEvents<T>(
    descriptor: DomainDescriptor<T>,
    events: readonly StoredEvent<DecisionIntelligenceEventPayload<T>>[]
  ): DecisionIntelligenceRecord<T>[] {
    return events.map((event, index) => {
      const record = this.recordFromEvent(descriptor, event);
      if (record.version !== index + 1) {
        throw new Error(`Decision intelligence version gap at ${record.recordId}`);
      }
      return record;
    });
  }

  private verifyReceipt(
    receipt: AuthorityReceipt,
    input: {
      requestId: string;
      requestHash: string;
      operation: string;
      eventId: string;
      responseHash: string;
      completedAt: string;
    }
  ): void {
    if (
      receipt.requestId !== input.requestId
      || receipt.requestHash !== input.requestHash
      || receipt.operation !== input.operation
      || receipt.eventId !== input.eventId
      || receipt.responseHash !== input.responseHash
      || receipt.completedAt !== input.completedAt
    ) throw new Error("Decision intelligence authority receipt binding is invalid");
    assertCanonicalTimestamp(receipt.completedAt, "Decision intelligence receipt time");
  }

  private persistReceipt(receipt: AuthorityReceipt): void {
    try {
      this.store.recordAuthorityReceipt(receipt);
    } catch (error) {
      const existing = this.store.findAuthorityReceipt(receipt.requestId);
      if (!existing) throw error;
      this.verifyReceipt(existing, {
        requestId: receipt.requestId,
        requestHash: receipt.requestHash,
        operation: receipt.operation,
        eventId: receipt.eventId ?? "",
        responseHash: receipt.responseHash,
        completedAt: receipt.completedAt
      });
    }
  }

  private async replayOrReject<T>(
    descriptor: DomainDescriptor<T>,
    input: {
      requestId: string;
      requestHash: string;
      operation: string;
      eventId: string;
    }
  ): Promise<DecisionIntelligenceRecord<T> | null> {
    const receipt = this.store.findAuthorityReceipt(input.requestId);
    if (receipt) {
      if (receipt.requestHash !== input.requestHash || receipt.operation !== input.operation) {
        throw new Error("Decision intelligence authority request id was reused with different parameters");
      }
      if (receipt.eventId !== input.eventId) {
        throw new Error("Decision intelligence authority receipt references a non-deterministic event");
      }
      const event = await this.store.readEvent<DecisionIntelligenceEventPayload<T>>(input.eventId);
      if (!event) throw new Error("Decision intelligence authority receipt references a missing event");
      const response = this.recordFromEvent(descriptor, event);
      this.verifyReceipt(receipt, {
        ...input,
        responseHash: sha256(stableStringify(response)),
        completedAt: event.occurredAt
      });
      return response;
    }

    const committed = await this.store.readEvent<DecisionIntelligenceEventPayload<T>>(input.eventId);
    if (!committed) return null;
    const response = this.recordFromEvent(descriptor, committed);
    if (
      response.authority.requestId !== input.requestId
      || response.authority.requestHash !== input.requestHash
      || response.authority.operation !== input.operation
    ) throw new Error("Decision intelligence deterministic event is bound to another authority request");
    const responseHash = sha256(stableStringify(response));
    this.persistReceipt({
      requestId: input.requestId,
      requestHash: input.requestHash,
      operation: input.operation,
      eventId: input.eventId,
      responseHash,
      completedAt: committed.occurredAt
    });
    return response;
  }

  private async record<T>(
    descriptor: DomainDescriptor<T>,
    input: DecisionIntelligenceRecordCommand<T>
  ): Promise<DecisionIntelligenceRecord<T>> {
    return this.mutations.run(async () => {
      assertExpectedVersion(input.expectedVersion);
      assertAuthorityRequestId(input.authorityRequestId);
      const value = canonicalClone(input.value);
      const operation = descriptor.recordOperation;
      const requestHash = canonicalRequestHash(operation, input.expectedVersion, value);
      const eventId = deterministicEventId(input.authorityRequestId);
      const replay = await this.replayOrReject(descriptor, {
        requestId: input.authorityRequestId,
        requestHash,
        operation,
        eventId
      });
      if (replay) return replay;

      descriptor.validate(value);
      const recordId = descriptor.idOf(value);
      assertIdentifier(recordId, "Decision intelligence record id");

      const existing = this.recordsFromEvents(
        descriptor,
        await this.store.readAggregate<DecisionIntelligenceEventPayload<T>>(
          aggregateType(descriptor.domain),
          recordId
        )
      );
      const currentVersion = existing.at(-1)?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new Error(
          `Decision intelligence version conflict, expected ${input.expectedVersion}, current ${currentVersion}`
        );
      }
      const recordedAt = canonicalTimestamp(input.now ?? new Date());
      const record = deepFreeze<DecisionIntelligenceRecord<T>>({
        domain: descriptor.domain,
        recordId,
        version: currentVersion + 1,
        value,
        valueHash: sha256(stableStringify(value)),
        authority: {
          requestId: input.authorityRequestId,
          requestHash,
          operation
        },
        recordedAt
      });
      this.verifyRecord(descriptor, record);
      const responseHash = sha256(stableStringify(record));
      await this.store.append<DecisionIntelligenceEventPayload<T>>({
        eventId,
        aggregateType: aggregateType(descriptor.domain),
        aggregateId: recordId,
        eventType: EVENT_TYPE,
        schemaVersion: EVENT_SCHEMA_VERSION,
        occurredAt: new Date(recordedAt),
        payload: {
          record,
          response: record,
          metadata: {
            authority: {
              ...record.authority,
              responseHash
            }
          }
        }
      });
      this.persistReceipt({
        requestId: input.authorityRequestId,
        requestHash,
        operation,
        eventId,
        responseHash,
        completedAt: recordedAt
      });
      return record;
    });
  }

  private async get<T>(
    descriptor: DomainDescriptor<T>,
    recordId: string
  ): Promise<DecisionIntelligenceRecord<T> | null> {
    assertIdentifier(recordId, "Decision intelligence record id");
    const records = this.recordsFromEvents(
      descriptor,
      await this.store.readAggregate<DecisionIntelligenceEventPayload<T>>(
        aggregateType(descriptor.domain),
        recordId
      )
    );
    return records.at(-1) ?? null;
  }

  private async list<T>(descriptor: DomainDescriptor<T>): Promise<DecisionIntelligenceRecord<T>[]> {
    const events = (await this.store.readAll<DecisionIntelligenceEventPayload<T>>())
      .filter((event) => event.aggregateType === aggregateType(descriptor.domain));
    const byId = new Map<string, StoredEvent<DecisionIntelligenceEventPayload<T>>[]>();
    for (const event of events) {
      const aggregate = byId.get(event.aggregateId) ?? [];
      aggregate.push(event);
      byId.set(event.aggregateId, aggregate);
    }
    return [...byId.values()]
      .flatMap((aggregate) => {
        const latest = this.recordsFromEvents(descriptor, aggregate).at(-1);
        return latest ? [latest] : [];
      })
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
  }

  public recordSourceObservation(
    input: DecisionIntelligenceRecordCommand<SourceObservation>
  ): Promise<DecisionIntelligenceRecord<SourceObservation>> {
    return this.record(SOURCE_OBSERVATION_DESCRIPTOR, input);
  }

  public getSourceObservation(recordId: string): Promise<DecisionIntelligenceRecord<SourceObservation> | null> {
    return this.get(SOURCE_OBSERVATION_DESCRIPTOR, recordId);
  }

  public listSourceObservations(): Promise<DecisionIntelligenceRecord<SourceObservation>[]> {
    return this.list(SOURCE_OBSERVATION_DESCRIPTOR);
  }

  public recordOpportunityTruth(
    input: DecisionIntelligenceRecordCommand<OpportunityTruthRecord>
  ): Promise<DecisionIntelligenceRecord<OpportunityTruthRecord>> {
    return this.record(OPPORTUNITY_TRUTH_DESCRIPTOR, input);
  }

  public getOpportunityTruth(recordId: string): Promise<DecisionIntelligenceRecord<OpportunityTruthRecord> | null> {
    return this.get(OPPORTUNITY_TRUTH_DESCRIPTOR, recordId);
  }

  public listOpportunityTruthRecords(): Promise<DecisionIntelligenceRecord<OpportunityTruthRecord>[]> {
    return this.list(OPPORTUNITY_TRUTH_DESCRIPTOR);
  }

  public recordLivenessAssessment(
    input: DecisionIntelligenceRecordCommand<LivenessAssessment>
  ): Promise<DecisionIntelligenceRecord<LivenessAssessment>> {
    return this.record(LIVENESS_DESCRIPTOR, input);
  }

  public getLivenessAssessment(recordId: string): Promise<DecisionIntelligenceRecord<LivenessAssessment> | null> {
    return this.get(LIVENESS_DESCRIPTOR, recordId);
  }

  public listLivenessAssessments(): Promise<DecisionIntelligenceRecord<LivenessAssessment>[]> {
    return this.list(LIVENESS_DESCRIPTOR);
  }

  public recordDedupeResult(
    input: DecisionIntelligenceRecordCommand<DedupeResult>
  ): Promise<DecisionIntelligenceRecord<DedupeResult>> {
    return this.record(DEDUPE_DESCRIPTOR, input);
  }

  public getDedupeResult(recordId: string): Promise<DecisionIntelligenceRecord<DedupeResult> | null> {
    return this.get(DEDUPE_DESCRIPTOR, recordId);
  }

  public listDedupeResults(): Promise<DecisionIntelligenceRecord<DedupeResult>[]> {
    return this.list(DEDUPE_DESCRIPTOR);
  }

  public recordTaxonomySnapshot(
    input: DecisionIntelligenceRecordCommand<TaxonomySnapshot>
  ): Promise<DecisionIntelligenceRecord<TaxonomySnapshot>> {
    return this.record(TAXONOMY_SNAPSHOT_DESCRIPTOR, input);
  }

  public getTaxonomySnapshot(recordId: string): Promise<DecisionIntelligenceRecord<TaxonomySnapshot> | null> {
    return this.get(TAXONOMY_SNAPSHOT_DESCRIPTOR, recordId);
  }

  public listTaxonomySnapshots(): Promise<DecisionIntelligenceRecord<TaxonomySnapshot>[]> {
    return this.list(TAXONOMY_SNAPSHOT_DESCRIPTOR);
  }

  public recordTaxonomyMappingSet(
    input: DecisionIntelligenceRecordCommand<TaxonomyMappingSet>
  ): Promise<DecisionIntelligenceRecord<TaxonomyMappingSet>> {
    return this.record(TAXONOMY_MAPPING_DESCRIPTOR, input);
  }

  public getTaxonomyMappingSet(recordId: string): Promise<DecisionIntelligenceRecord<TaxonomyMappingSet> | null> {
    return this.get(TAXONOMY_MAPPING_DESCRIPTOR, recordId);
  }

  public listTaxonomyMappingSets(): Promise<DecisionIntelligenceRecord<TaxonomyMappingSet>[]> {
    return this.list(TAXONOMY_MAPPING_DESCRIPTOR);
  }

  public recordCareerAssuranceCase(
    input: DecisionIntelligenceRecordCommand<CareerAssuranceCase>
  ): Promise<DecisionIntelligenceRecord<CareerAssuranceCase>> {
    return this.record(ASSURANCE_DESCRIPTOR, input);
  }

  public getCareerAssuranceCase(recordId: string): Promise<DecisionIntelligenceRecord<CareerAssuranceCase> | null> {
    return this.get(ASSURANCE_DESCRIPTOR, recordId);
  }

  public listCareerAssuranceCases(): Promise<DecisionIntelligenceRecord<CareerAssuranceCase>[]> {
    return this.list(ASSURANCE_DESCRIPTOR);
  }

  public recordCredentialPassport(
    input: DecisionIntelligenceRecordCommand<CredentialPassportEntry>
  ): Promise<DecisionIntelligenceRecord<CredentialPassportEntry>> {
    return this.record(CREDENTIAL_PASSPORT_DESCRIPTOR, input);
  }

  public getCredentialPassport(recordId: string): Promise<DecisionIntelligenceRecord<CredentialPassportEntry> | null> {
    return this.get(CREDENTIAL_PASSPORT_DESCRIPTOR, recordId);
  }

  public listCredentialPassports(): Promise<DecisionIntelligenceRecord<CredentialPassportEntry>[]> {
    return this.list(CREDENTIAL_PASSPORT_DESCRIPTOR);
  }

  public recordCredentialMappingPlan(
    input: DecisionIntelligenceRecordCommand<CredentialMappingPlan>
  ): Promise<DecisionIntelligenceRecord<CredentialMappingPlan>> {
    return this.record(CREDENTIAL_MAPPING_DESCRIPTOR, input);
  }

  public getCredentialMappingPlan(recordId: string): Promise<DecisionIntelligenceRecord<CredentialMappingPlan> | null> {
    return this.get(CREDENTIAL_MAPPING_DESCRIPTOR, recordId);
  }

  public listCredentialMappingPlans(): Promise<DecisionIntelligenceRecord<CredentialMappingPlan>[]> {
    return this.list(CREDENTIAL_MAPPING_DESCRIPTOR);
  }
}
