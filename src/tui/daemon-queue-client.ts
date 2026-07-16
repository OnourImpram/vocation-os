import { randomUUID } from "node:crypto";
import type { AuthorityOperation } from "@vocation-os/sdk";

const QUEUE_STATUSES = ["prepared", "approved", "submitted_unconfirmed", "confirmed", "blocked", "ready", "needs_review"] as const;
type QueueStatus = (typeof QUEUE_STATUSES)[number];
type QueueKind = "applications" | "discovery";

export interface TuiAuthorityClient {
  request(operation: AuthorityOperation, payload?: unknown, options?: { requestId?: string }): Promise<unknown>;
}

export interface TuiQueueQuery {
  queueKinds: readonly QueueKind[];
  statuses: readonly QueueStatus[];
  query: string | null;
  attentionOnly: boolean;
  providers: readonly string[];
  liveness: readonly string[];
  duplicateStatuses: readonly string[];
  minimumTaxonomyConfidence: number | null;
  truthStatuses: readonly string[];
  campaignIds: readonly string[];
}

export interface TuiQueueCommand {
  kind:
    | "approval.request"
    | "attempt.block"
    | "attempt.rearm"
    | "confirmation.review"
    | "discovery.accept-review"
    | "discovery.reject-review"
    | "discovery.merge-proposal"
    | "discovery.keep-separate"
    | "discovery.snooze"
    | "discovery.refresh-evidence"
    | "discovery.build-assurance";
  attemptId: string;
  opportunityId: string;
  expectedVersion: number;
}

export interface TuiQueueEvidence {
  id: string;
  label: string;
  status: "verified" | "operator-supplied" | "stale" | "missing";
  source: string | null;
}

export interface TuiQueueItem {
  queueKind: QueueKind;
  attemptId: string;
  opportunityId: string;
  title: string;
  organization: string;
  status: QueueStatus;
  priority: "critical" | "high" | "normal" | "low";
  updatedAt: string;
  version: number;
  blocker: string | null;
  summary: string | null;
  evidence: TuiQueueEvidence[];
  providerId: string | null;
  liveness: string | null;
  duplicateStatus: string | null;
  taxonomyConfidence: number | null;
  truthStatus: string | null;
  campaignId: string | null;
}

export interface TuiQueueCommandResult {
  accepted: boolean;
  requestId: string;
  message: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error("Daemon returned a malformed queue collection");
  }
  return value;
}

function recordValue(record: UnknownRecord): UnknownRecord {
  const value = record["value"];
  if (!isRecord(value)) throw new Error("Daemon queue record is missing its canonical value");
  return value;
}

function requiredString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Daemon queue record is missing ${key}`);
  }
  return value;
}

function optionalString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requiredVersion(record: UnknownRecord): number {
  const value = record["version"];
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Daemon queue record has an invalid version");
  return value as number;
}

function queueStatus(value: unknown): QueueStatus {
  if (typeof value !== "string" || !QUEUE_STATUSES.includes(value as QueueStatus)) {
    throw new Error("Daemon queue record has an unsupported status");
  }
  return value as QueueStatus;
}

function priority(status: QueueStatus): TuiQueueItem["priority"] {
  if (status === "blocked") return "critical";
  if (status === "submitted_unconfirmed") return "high";
  if (status === "prepared" || status === "approved") return "normal";
  return "low";
}

function requestId(prefix = "REQ-TUI"): string {
  return `${prefix}-${randomUUID()}`;
}

function opportunityIndex(records: UnknownRecord[]): Map<string, UnknownRecord> {
  return new Map(records.map((record) => {
    const value = recordValue(record);
    return [requiredString(value, "opportunityId"), value];
  }));
}

function evidenceForAttempt(value: UnknownRecord): TuiQueueEvidence[] {
  const status = queueStatus(value["status"]);
  const packetHash = optionalString(value, "packetHash");
  const approvalId = optionalString(value, "approvalId");
  const proofId = optionalString(value, "proofId");
  return [{
    id: `${requiredString(value, "attemptId")}:packet`,
    label: "Application packet binding",
    status: packetHash ? "verified" : "missing",
    source: packetHash
  }, {
    id: `${requiredString(value, "attemptId")}:approval`,
    label: "Scoped human authorization",
    status: approvalId ? "operator-supplied" : "missing",
    source: approvalId
  }, {
    id: `${requiredString(value, "attemptId")}:proof`,
    label: "Trusted submission proof",
    status: status === "confirmed" && proofId ? "verified" : "missing",
    source: proofId
  }];
}

function mapQueueItem(record: UnknownRecord, opportunities: Map<string, UnknownRecord>): TuiQueueItem {
  const value = recordValue(record);
  const opportunityId = requiredString(value, "opportunityId");
  const opportunity = opportunities.get(opportunityId);
  const status = queueStatus(value["status"]);
  return {
    queueKind: "applications",
    attemptId: requiredString(value, "attemptId"),
    opportunityId,
    title: opportunity ? requiredString(opportunity, "roleTitle") : opportunityId,
    organization: opportunity ? requiredString(opportunity, "company") : requiredString(value, "adapterId"),
    status,
    priority: priority(status),
    updatedAt: requiredString(value, "updatedAt"),
    version: requiredVersion(record),
    blocker: optionalString(value, "blocker"),
    summary: opportunity ? optionalString(opportunity, "locationText") : null,
    evidence: evidenceForAttempt(value),
    providerId: optionalString(value, "adapterId"),
    liveness: null,
    duplicateStatus: null,
    taxonomyConfidence: null,
    truthStatus: null,
    campaignId: optionalString(value, "campaignId")
  };
}

function pagedItems(value: unknown): UnknownRecord[] {
  if (!isRecord(value)) throw new Error("Daemon returned a malformed discovery review page");
  return recordArray(value["items"]);
}

function optionalNumber(record: UnknownRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(record: UnknownRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function discoveryEvidence(value: UnknownRecord): TuiQueueEvidence[] {
  const evidenceIds = stringArray(value, "evidenceRecordIds");
  return [{
    id: `${requiredString(value, "opportunityId")}:liveness`,
    label: "Provider liveness assessment",
    status: value["liveness"] === "live" ? "verified" : value["liveness"] === "stale" ? "stale" : "missing",
    source: evidenceIds.find((id) => id.startsWith("LIVE-")) ?? null
  }, {
    id: `${requiredString(value, "opportunityId")}:truth`,
    label: "Opportunity truth disposition",
    status: value["truthDisposition"] === "actionable" ? "verified" : "missing",
    source: evidenceIds.find((id) => id.startsWith("TRUTH-")) ?? null
  }, {
    id: `${requiredString(value, "opportunityId")}:dedupe`,
    label: "Duplicate assessment",
    status: value["duplicateStatus"] === "unassessed" ? "missing" : "verified",
    source: evidenceIds.find((id) => id.startsWith("DEDUPE-")) ?? null
  }];
}

function mapDiscoveryItem(value: UnknownRecord): TuiQueueItem {
  const opportunityId = requiredString(value, "opportunityId");
  const status = queueStatus(value["status"]);
  const liveness = optionalString(value, "liveness");
  const truthStatus = optionalString(value, "truthDisposition");
  const duplicateStatus = optionalString(value, "duplicateStatus");
  const blockers = stringArray(value, "truthBlockers");
  const duplicateCandidates = stringArray(value, "duplicateCandidateIds");
  return {
    queueKind: "discovery",
    attemptId: opportunityId,
    opportunityId,
    title: requiredString(value, "roleTitle"),
    organization: requiredString(value, "company"),
    status,
    priority: status === "blocked" ? "critical" : status === "needs_review" ? "high" : "normal",
    updatedAt: requiredString(value, "updatedAt"),
    version: requiredVersion(value),
    blocker: blockers.length > 0 ? blockers.join(", ") : null,
    summary: optionalString(value, "locationText"),
    evidence: discoveryEvidence(value),
    providerId: optionalString(value, "providerId"),
    liveness,
    duplicateStatus,
    taxonomyConfidence: optionalNumber(value, "taxonomyConfidence"),
    truthStatus,
    campaignId: optionalString(value, "campaignId")
  };
}

function reviewTask(command: TuiQueueCommand, kind: string, now: Date): UnknownRecord {
  const discoveryTitles: Readonly<Record<string, string>> = {
    "discovery.accept-review": "Review opportunity acceptance proposal",
    "discovery.reject-review": "Review opportunity rejection proposal",
    "discovery.merge-proposal": "Review duplicate merge proposal",
    "discovery.keep-separate": "Review keep-separate proposal",
    "discovery.snooze": "Review opportunity snooze request",
    "discovery.refresh-evidence": "Refresh opportunity evidence",
    "discovery.build-assurance": "Build Career Assurance Case"
  };
  const discovery = command.kind.startsWith("discovery.");
  return {
    taskId: `TSK-${kind.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${randomUUID().toUpperCase()}`,
    title: discovery
      ? discoveryTitles[command.kind] ?? "Review opportunity proposal"
      : kind === "approval" ? "Review application approval" : "Review submission evidence",
    status: "pending",
    priority: kind === "approval" ? 1 : 0,
    relatedDomain: discovery ? "opportunities" : "applications",
    relatedRecordId: discovery ? command.opportunityId : command.attemptId,
    dueAt: null,
    completedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

export function createTuiDaemonQueueClient(authority: TuiAuthorityClient) {
  return Object.freeze({
    async queryQueue(query: TuiQueueQuery): Promise<readonly TuiQueueItem[]> {
      const applicationRequested = query.queueKinds.includes("applications");
      const discoveryRequested = query.queueKinds.includes("discovery");
      const [attemptResult, opportunityResult, discoveryResult] = await Promise.all([
        applicationRequested ? authority.request("tracker-list", {}) : Promise.resolve([]),
        applicationRequested ? authority.request("domain-list", { domain: "opportunities" }) : Promise.resolve([]),
        discoveryRequested
          ? authority.request("discovery-review-list", { cursor: null, limit: 100 })
          : Promise.resolve({ items: [] })
      ]);
      const opportunities = opportunityIndex(recordArray(opportunityResult));
      const selectedStatuses = new Set(query.statuses);
      const normalizedQuery = query.query?.trim().toLocaleLowerCase() ?? "";
      const providers = new Set(query.providers);
      const liveness = new Set(query.liveness);
      const duplicateStatuses = new Set(query.duplicateStatuses);
      const truthStatuses = new Set(query.truthStatuses);
      const campaignIds = new Set(query.campaignIds);
      return [
        ...recordArray(attemptResult).map((record) => mapQueueItem(record, opportunities)),
        ...pagedItems(discoveryResult).map(mapDiscoveryItem)
      ]
        .filter((item) => selectedStatuses.has(item.status))
        .filter((item) => !query.attentionOnly || (item.status !== "confirmed" && item.status !== "ready"))
        .filter((item) => providers.size === 0 || (item.providerId !== null && providers.has(item.providerId)))
        .filter((item) => liveness.size === 0 || (item.liveness !== null && liveness.has(item.liveness)))
        .filter((item) => duplicateStatuses.size === 0 || (item.duplicateStatus !== null && duplicateStatuses.has(item.duplicateStatus)))
        .filter((item) => truthStatuses.size === 0 || (item.truthStatus !== null && truthStatuses.has(item.truthStatus)))
        .filter((item) => campaignIds.size === 0 || (item.campaignId !== null && campaignIds.has(item.campaignId)))
        .filter((item) => query.minimumTaxonomyConfidence === null
          || (item.taxonomyConfidence !== null && item.taxonomyConfidence >= query.minimumTaxonomyConfidence))
        .filter((item) => normalizedQuery.length === 0 || [
          item.title,
          item.organization,
          item.opportunityId,
          item.attemptId
        ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
    },

    async executeQueueCommand(command: TuiQueueCommand): Promise<TuiQueueCommandResult> {
      const operationRequestId = requestId();
      if (command.kind === "attempt.rearm") {
        return {
          accepted: false,
          requestId: operationRequestId,
          message: "Rearm requires a separately scoped approval outside the review-only TUI"
        };
      }
      if (command.kind.startsWith("discovery.")) {
        const now = new Date();
        await authority.request("domain-put", {
          domain: "tasks",
          value: reviewTask(command, command.kind, now),
          expectedVersion: 0
        }, { requestId: operationRequestId });
        return {
          accepted: true,
          requestId: operationRequestId,
          message: "Discovery review proposal recorded as an audited task"
        };
      }
      if (command.kind === "attempt.block") {
        await authority.request("tracker-block", {
          attemptId: command.attemptId,
          expectedVersion: command.expectedVersion,
          blocker: "Blocked by operator from the TUI review queue"
        }, { requestId: operationRequestId });
        return { accepted: true, requestId: operationRequestId, message: "Application attempt blocked" };
      }
      const now = new Date();
      const kind = command.kind === "approval.request" ? "approval" : "confirmation";
      await authority.request("domain-put", {
        domain: "tasks",
        value: reviewTask(command, kind, now),
        expectedVersion: 0
      }, { requestId: operationRequestId });
      return {
        accepted: true,
        requestId: operationRequestId,
        message: kind === "approval" ? "Approval review task created" : "Confirmation evidence review task created"
      };
    }
  });
}
