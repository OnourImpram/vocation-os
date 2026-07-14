import { sha256, stableStringify } from "../hash.js";
import { validateCareerTwin, type CareerTwin } from "../career-twin.js";
import type { DocumentAst } from "../document-ast.js";
import type { DocumentAstV2 } from "../documents/document-ast-v2.js";
import type { OpportunityRecord } from "../opportunity.js";
import type { ApplicationAttempt } from "../application-lifecycle.js";
import type { CareerOutcomeEvent } from "../outcome-learning.js";
import { assertAnswerMemory, type AnswerMemoryRecord } from "../answer-memory.js";
import { assertSchema } from "../schema.js";
import type { EncryptedEventStore, StoredEvent } from "./encrypted-event-store.js";

export const PRODUCT_DOMAIN_NAMES = [
  "profiles",
  "opportunities",
  "documents",
  "campaigns",
  "applications",
  "tasks",
  "outcomes",
  "answers"
] as const;

export type ProductDomainName = (typeof PRODUCT_DOMAIN_NAMES)[number];
export type DomainRecordStatus = "active" | "archived";
export type StoredDocumentAst = DocumentAst | DocumentAstV2;

export interface CampaignRecord {
  campaignId: string;
  profileId: string;
  name: string;
  objective: string;
  status: "draft" | "active" | "paused" | "completed";
  opportunityIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CareerTaskRecord {
  taskId: string;
  title: string;
  status: "pending" | "in-progress" | "completed" | "cancelled";
  priority: number;
  relatedDomain: ProductDomainName | null;
  relatedRecordId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionedDomainRecord<T> {
  domain: ProductDomainName;
  recordId: string;
  version: number;
  status: DomainRecordStatus;
  value: T;
  valueHash: string;
  operationId: string;
  recordedAt: string;
}

export interface DomainAuthorityBindingInput {
  requestId: string;
  requestHash: string;
  operation: string;
}

interface DomainEventPayload<T> {
  record: VersionedDomainRecord<T>;
  response: VersionedDomainRecord<T>;
  audit?: unknown;
  metadata?: {
    authority?: DomainAuthorityBindingInput & { responseHash: string };
  };
}

interface DomainDescriptor<T> {
  domain: ProductDomainName;
  idOf(value: T): string;
  validate(value: T): void;
}

class DomainMutationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function assertOperationId(value: string): void {
  if (!/^REQ-[A-Za-z0-9-]{8,100}$/.test(value)) {
    throw new Error("Domain operation id must be an authority request id");
  }
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Domain expected version must be a non-negative safe integer");
  }
}

function eventId(domain: ProductDomainName, operationId: string): string {
  return `EVT-DOM-${sha256(`${domain}:${operationId}`).slice("sha256:".length)}`;
}

function verifyRecord<T>(descriptor: DomainDescriptor<T>, record: VersionedDomainRecord<T>): void {
  if (record.domain !== descriptor.domain) throw new Error("Domain record belongs to another repository");
  assertIdentifier(record.recordId, "Domain record id");
  assertOperationId(record.operationId);
  if (!Number.isSafeInteger(record.version) || record.version < 1) throw new Error("Domain record version is invalid");
  if (record.status !== "active" && record.status !== "archived") throw new Error("Domain record status is invalid");
  if (!Number.isFinite(Date.parse(record.recordedAt))) throw new Error("Domain record timestamp is invalid");
  descriptor.validate(record.value);
  if (descriptor.idOf(record.value) !== record.recordId) throw new Error("Domain record id does not match its value");
  if (record.valueHash !== sha256(stableStringify(record.value))) throw new Error("Domain record value hash is invalid");
}

export class EventSourcedDomainRepository<T> {
  public constructor(
    private readonly store: EncryptedEventStore,
    private readonly descriptor: DomainDescriptor<T>,
    private readonly mutations = new DomainMutationCoordinator()
  ) {}

  private async events(recordId: string): Promise<StoredEvent<DomainEventPayload<T>>[]> {
    assertIdentifier(recordId, "Domain record id");
    return this.store.readAggregate<DomainEventPayload<T>>(`domain-${this.descriptor.domain}`, recordId);
  }

  private recordsFromEvents(events: StoredEvent<DomainEventPayload<T>>[]): VersionedDomainRecord<T>[] {
    return events.map((event, index) => {
      const record = event.payload.record;
      verifyRecord(this.descriptor, record);
      if (record.version !== index + 1) throw new Error(`Domain record version gap at ${record.recordId}`);
      if (event.payload.response.valueHash !== record.valueHash) throw new Error("Domain event response is not bound to its record");
      return record;
    });
  }

  public async get(recordId: string, includeArchived = false): Promise<VersionedDomainRecord<T> | null> {
    const records = this.recordsFromEvents(await this.events(recordId));
    const latest = records.at(-1) ?? null;
    return latest?.status === "archived" && !includeArchived ? null : latest;
  }

  public async list(includeArchived = false): Promise<VersionedDomainRecord<T>[]> {
    const events = (await this.store.readAll<DomainEventPayload<T>>())
      .filter((event) => event.aggregateType === `domain-${this.descriptor.domain}`);
    const byId = new Map<string, StoredEvent<DomainEventPayload<T>>[]>();
    for (const event of events) {
      const aggregate = byId.get(event.aggregateId) ?? [];
      aggregate.push(event);
      byId.set(event.aggregateId, aggregate);
    }
    const records = [...byId.values()].flatMap((aggregate) => {
      const latest = this.recordsFromEvents(aggregate).at(-1);
      return latest ? [latest] : [];
    });
    return records
      .filter((record) => includeArchived || record.status === "active")
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
  }

  public async put(input: {
    value: T;
    expectedVersion: number;
    operationId: string;
    eventId?: string;
    now?: Date;
    authority?: DomainAuthorityBindingInput;
    audit?: unknown;
  }): Promise<VersionedDomainRecord<T>> {
    return this.mutations.run(() => this.putSerialized(input));
  }

  private async putSerialized(input: {
    value: T;
    expectedVersion: number;
    operationId: string;
    eventId?: string;
    now?: Date;
    authority?: DomainAuthorityBindingInput;
    audit?: unknown;
  }): Promise<VersionedDomainRecord<T>> {
    this.descriptor.validate(input.value);
    const recordId = this.descriptor.idOf(input.value);
    assertIdentifier(recordId, "Domain record id");
    assertExpectedVersion(input.expectedVersion);
    assertOperationId(input.operationId);
    const existingRecords = this.recordsFromEvents(await this.events(recordId));
    const replay = existingRecords.find((record) => record.operationId === input.operationId);
    const valueHash = sha256(stableStringify(input.value));
    if (replay) {
      if (replay.valueHash !== valueHash || replay.status !== "active") {
        throw new Error("Domain operation id was replayed with different content");
      }
      return replay;
    }
    const currentVersion = existingRecords.at(-1)?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new Error(`Domain version conflict, expected ${input.expectedVersion}, current ${currentVersion}`);
    }
    const record: VersionedDomainRecord<T> = {
      domain: this.descriptor.domain,
      recordId,
      version: currentVersion + 1,
      status: "active",
      value: input.value,
      valueHash,
      operationId: input.operationId,
      recordedAt: (input.now ?? new Date()).toISOString()
    };
    verifyRecord(this.descriptor, record);
    const responseHash = sha256(stableStringify(record));
    await this.store.append<DomainEventPayload<T>>({
      eventId: input.eventId ?? eventId(this.descriptor.domain, input.operationId),
      aggregateType: `domain-${this.descriptor.domain}`,
      aggregateId: recordId,
      eventType: "domain-record-put",
      schemaVersion: 1,
      occurredAt: new Date(record.recordedAt),
      payload: {
        record,
        response: record,
        ...(input.audit !== undefined ? { audit: input.audit } : {}),
        ...(input.authority ? { metadata: { authority: { ...input.authority, responseHash } } } : {})
      }
    });
    return record;
  }

  public async archive(input: {
    recordId: string;
    expectedVersion: number;
    operationId: string;
    eventId?: string;
    now?: Date;
    authority?: DomainAuthorityBindingInput;
  }): Promise<VersionedDomainRecord<T>> {
    return this.mutations.run(() => this.archiveSerialized(input));
  }

  private async archiveSerialized(input: {
    recordId: string;
    expectedVersion: number;
    operationId: string;
    eventId?: string;
    now?: Date;
    authority?: DomainAuthorityBindingInput;
  }): Promise<VersionedDomainRecord<T>> {
    assertExpectedVersion(input.expectedVersion);
    assertOperationId(input.operationId);
    const existingRecords = this.recordsFromEvents(await this.events(input.recordId));
    const replay = existingRecords.find((record) => record.operationId === input.operationId);
    if (replay) {
      if (replay.status !== "archived") throw new Error("Domain operation id was replayed with different content");
      return replay;
    }
    const current = existingRecords.at(-1);
    if (!current) throw new Error(`Domain record not found: ${input.recordId}`);
    if (current.version !== input.expectedVersion) {
      throw new Error(`Domain version conflict, expected ${input.expectedVersion}, current ${current.version}`);
    }
    if (current.status === "archived") return current;
    const record: VersionedDomainRecord<T> = {
      ...current,
      version: current.version + 1,
      status: "archived",
      operationId: input.operationId,
      recordedAt: (input.now ?? new Date()).toISOString()
    };
    const responseHash = sha256(stableStringify(record));
    await this.store.append<DomainEventPayload<T>>({
      eventId: input.eventId ?? eventId(this.descriptor.domain, input.operationId),
      aggregateType: `domain-${this.descriptor.domain}`,
      aggregateId: input.recordId,
      eventType: "domain-record-archived",
      schemaVersion: 1,
      occurredAt: new Date(record.recordedAt),
      payload: {
        record,
        response: record,
        ...(input.authority ? { metadata: { authority: { ...input.authority, responseHash } } } : {})
      }
    });
    return record;
  }
}

export class ProductRepositories {
  public readonly profiles: EventSourcedDomainRepository<CareerTwin>;
  public readonly opportunities: EventSourcedDomainRepository<OpportunityRecord>;
  public readonly documents: EventSourcedDomainRepository<StoredDocumentAst>;
  public readonly campaigns: EventSourcedDomainRepository<CampaignRecord>;
  public readonly applications: EventSourcedDomainRepository<ApplicationAttempt>;
  public readonly tasks: EventSourcedDomainRepository<CareerTaskRecord>;
  public readonly outcomes: EventSourcedDomainRepository<CareerOutcomeEvent>;
  public readonly answers: EventSourcedDomainRepository<AnswerMemoryRecord>;

  public constructor(store: EncryptedEventStore) {
    const mutations = new DomainMutationCoordinator();
    this.profiles = new EventSourcedDomainRepository(store, {
      domain: "profiles",
      idOf: (value) => value.twinId,
      validate: (value) => {
        const result = validateCareerTwin(value);
        if (!result.valid) throw new Error(`Career twin validation failed: ${result.reasons.join(", ")}`);
      }
    }, mutations);
    this.opportunities = new EventSourcedDomainRepository(store, {
      domain: "opportunities",
      idOf: (value) => value.opportunityId,
      validate: (value) => assertSchema("opportunity-record", value)
    }, mutations);
    this.documents = new EventSourcedDomainRepository(store, {
      domain: "documents",
      idOf: (value) => value.documentId,
      validate: (value) => "schemaVersion" in value && value.schemaVersion === 2
        ? assertSchema("document-ast-v2", value)
        : assertSchema("document-ast", value)
    }, mutations);
    this.campaigns = new EventSourcedDomainRepository(store, {
      domain: "campaigns",
      idOf: (value) => value.campaignId,
      validate: (value) => assertSchema("campaign-record", value)
    }, mutations);
    this.applications = new EventSourcedDomainRepository(store, {
      domain: "applications",
      idOf: (value) => value.attemptId,
      validate: (value) => assertSchema("application-attempt", value)
    }, mutations);
    this.tasks = new EventSourcedDomainRepository(store, {
      domain: "tasks",
      idOf: (value) => value.taskId,
      validate: (value) => assertSchema("task-record", value)
    }, mutations);
    this.outcomes = new EventSourcedDomainRepository(store, {
      domain: "outcomes",
      idOf: (value) => value.outcomeId,
      validate: (value) => assertSchema("outcome-event", value)
    }, mutations);
    this.answers = new EventSourcedDomainRepository(store, {
      domain: "answers",
      idOf: (value) => value.answerId,
      validate: assertAnswerMemory
    }, mutations);
  }

  public repository(domain: "profiles"): EventSourcedDomainRepository<CareerTwin>;
  public repository(domain: "opportunities"): EventSourcedDomainRepository<OpportunityRecord>;
  public repository(domain: "documents"): EventSourcedDomainRepository<StoredDocumentAst>;
  public repository(domain: "campaigns"): EventSourcedDomainRepository<CampaignRecord>;
  public repository(domain: "applications"): EventSourcedDomainRepository<ApplicationAttempt>;
  public repository(domain: "tasks"): EventSourcedDomainRepository<CareerTaskRecord>;
  public repository(domain: "outcomes"): EventSourcedDomainRepository<CareerOutcomeEvent>;
  public repository(domain: "answers"): EventSourcedDomainRepository<AnswerMemoryRecord>;
  public repository(domain: ProductDomainName): EventSourcedDomainRepository<unknown>;
  public repository(domain: ProductDomainName): EventSourcedDomainRepository<unknown> {
    return this[domain] as EventSourcedDomainRepository<unknown>;
  }
}
