import type { AuthorityOperation } from "@vocation-os/sdk";

export const WORKBENCH_ROUTE_IDS = [
  "today",
  "discovery",
  "review",
  "twin",
  "documents",
  "pipeline",
  "evidence",
  "approvals",
  "audit",
  "credentials",
  "interview",
  "offers",
  "settings"
] as const;

export type WorkbenchRouteId = (typeof WORKBENCH_ROUTE_IDS)[number];

export interface WorkbenchAuthorityReader {
  request(operation: AuthorityOperation, payload?: unknown, options?: { requestId?: string }): Promise<unknown>;
}

export interface WorkbenchMetric {
  id: string;
  label: string;
  value: string;
  detail: string | null;
}

export interface WorkbenchField {
  label: string;
  value: string;
}

export interface WorkbenchListItem {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  tone: "neutral" | "positive" | "attention" | "critical";
  fields: WorkbenchField[];
}

export interface WorkbenchAction {
  id: string;
  label: string;
  endpoint: string;
  capability: string;
  approvalId: string | null;
  tone: "neutral" | "primary" | "danger";
  requiresConfirmation: boolean;
}

export interface WorkbenchRoutePayload {
  summary: string;
  generatedAt: string;
  metrics: WorkbenchMetric[];
  items: WorkbenchListItem[];
  details: WorkbenchField[];
  actions: WorkbenchAction[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nestedRecord(value: UnknownRecord, key: string): UnknownRecord {
  return isRecord(value[key]) ? value[key] : value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function recordId(record: UnknownRecord): string {
  return stringValue(record["recordId"], stringValue(record["id"], "unidentified"));
}

function domainValue(record: UnknownRecord): UnknownRecord {
  return nestedRecord(record, "value");
}

function metric(id: string, label: string, value: number | string, detail: string | null = null): WorkbenchMetric {
  return { id, label, value: String(value), detail };
}

function field(label: string, value: unknown, fallback = "Not recorded"): WorkbenchField {
  return { label, value: stringValue(value, fallback) };
}

function toneForStatus(status: string): WorkbenchListItem["tone"] {
  if (["confirmed", "verified", "active", "live", "completed"].includes(status)) return "positive";
  if (["blocked", "rejected", "revoked", "failed", "closed"].includes(status)) return "critical";
  if (["prepared", "approved", "stale", "unresolved", "pending", "in-progress"].includes(status)) return "attention";
  return "neutral";
}

function discoveryReviewItem(value: UnknownRecord): WorkbenchListItem {
  const status = stringValue(value["status"], "needs_review");
  const taxonomyConfidence = value["taxonomyConfidence"];
  return {
    id: stringValue(value["opportunityId"], "unidentified-opportunity"),
    title: stringValue(value["roleTitle"], "Untitled opportunity"),
    subtitle: stringValue(value["company"], "Organization not recorded"),
    status,
    tone: toneForStatus(status === "ready" ? "active" : status === "needs_review" ? "pending" : status),
    fields: [
      field("Provider", value["providerId"]),
      field("Liveness", value["liveness"]),
      field("Truth", value["truthDisposition"]),
      field("Dedupe", value["duplicateStatus"]),
      {
        label: "Taxonomy confidence",
        value: typeof taxonomyConfidence === "number" ? taxonomyConfidence.toFixed(2) : "Not mapped"
      },
      field("Location", value["locationText"])
    ]
  };
}

function pageItems(value: unknown): UnknownRecord[] {
  return isRecord(value) ? records(value["items"]) : [];
}

async function readDecisionDetails(
  authority: WorkbenchAuthorityReader,
  listOperation: AuthorityOperation,
  getOperation: AuthorityOperation,
  requestId: () => string,
  limit = 25
): Promise<UnknownRecord[]> {
  const summaries = pageItems(await read(authority, listOperation, { cursor: null, limit }, requestId));
  const results: UnknownRecord[] = [];
  for (let offset = 0; offset < summaries.length; offset += 5) {
    const chunk = summaries.slice(offset, offset + 5);
    const values = await Promise.all(chunk.map(async (summary) => {
      const recordIdValue = summary["recordId"];
      if (typeof recordIdValue !== "string") return null;
      const value = await read(authority, getOperation, { recordId: recordIdValue }, requestId);
      return isRecord(value) ? value : null;
    }));
    results.push(...values.filter((value): value is UnknownRecord => value !== null));
  }
  return results;
}

function credentialItem(record: UnknownRecord): WorkbenchListItem {
  const value = domainValue(record);
  const summary = isRecord(value["summary"]) ? value["summary"] : {};
  const verification = isRecord(value["verification"]) ? value["verification"] : {};
  const overall = stringValue(verification["overall"], "incomplete");
  return {
    id: stringValue(value["passportEntryId"], recordId(record)),
    title: stringValue(summary["achievementName"], "Credential"),
    subtitle: stringValue(summary["issuerId"], "Issuer not verified"),
    status: overall,
    tone: toneForStatus(overall),
    fields: [
      field("Subject", summary["subjectId"]),
      field("Valid from", summary["validFrom"]),
      field("Valid until", summary["validUntil"]),
      field("Envelope", value["envelopeFormat"]),
      field("Imported", value["importedAt"])
    ]
  };
}

function trackerItem(record: UnknownRecord): WorkbenchListItem {
  const value = domainValue(record);
  const status = stringValue(value["status"], "Unknown");
  return {
    id: recordId(record),
    title: stringValue(value["opportunityId"], "Unbound application"),
    subtitle: stringValue(value["adapterId"], "Adapter not recorded"),
    status,
    tone: toneForStatus(status.toLowerCase()),
    fields: [
      field("Channel", value["channel"]),
      field("Reversibility", value["reversibilityTag"]),
      field("Updated", value["updatedAt"])
    ]
  };
}

function genericDomainItem(record: UnknownRecord, titleKeys: readonly string[], subtitleKeys: readonly string[]): WorkbenchListItem {
  const value = domainValue(record);
  const title = titleKeys.map((key) => value[key]).find((candidate) => typeof candidate === "string");
  const subtitle = subtitleKeys.map((key) => value[key]).find((candidate) => typeof candidate === "string");
  const status = stringValue(value["status"], stringValue(record["status"], "Current"));
  return {
    id: recordId(record),
    title: stringValue(title, recordId(record)),
    subtitle: stringValue(subtitle, "Local authority record"),
    status,
    tone: toneForStatus(status.toLowerCase()),
    fields: [
      { label: "Version", value: String(numberValue(record["version"], 1)) },
      field("Recorded", record["recordedAt"]),
      field("Evidence hash", record["valueHash"])
    ]
  };
}

async function read(
  authority: WorkbenchAuthorityReader,
  operation: AuthorityOperation,
  payload: unknown,
  requestId: () => string
): Promise<unknown> {
  return authority.request(operation, payload, { requestId: requestId() });
}

function basePayload(summary: string): WorkbenchRoutePayload {
  return { summary, generatedAt: new Date().toISOString(), metrics: [], items: [], details: [], actions: [] };
}

export async function buildWorkbenchRoutePayload(
  routeId: WorkbenchRouteId,
  authority: WorkbenchAuthorityReader,
  requestId: () => string
): Promise<WorkbenchRoutePayload> {
  if (routeId === "today") {
    const [opportunitiesResult, trackerResult, approversResult, healthResult] = await Promise.all([
      read(authority, "domain-list", { domain: "opportunities" }, requestId),
      read(authority, "tracker-list", {}, requestId),
      read(authority, "approver-list", {}, requestId),
      read(authority, "health", {}, requestId)
    ]);
    const opportunities = records(opportunitiesResult);
    const attempts = records(trackerResult);
    const approvers = records(approversResult);
    const pending = attempts.filter((attempt) => stringValue(domainValue(attempt)["status"], "") !== "confirmed");
    return {
      ...basePayload("Current decisions requiring evidence review or operator authorization."),
      metrics: [
        metric("opportunities", "Opportunities", opportunities.length, "Canonical local records"),
        metric("review", "Needs review", pending.length, "No external action is implied"),
        metric("approvers", "Trusted approvers", approvers.length, "Authority registry entries")
      ],
      items: pending.slice(0, 20).map(trackerItem),
      details: [
        field("Daemon", isRecord(healthResult) ? healthResult["status"] : undefined, "Reachable"),
        { label: "Authority", value: "vocationd" },
        { label: "External effects", value: "Scoped approval required" }
      ]
    };
  }

  if (routeId === "discovery" || routeId === "review") {
    const [reviewPage, attemptsResult] = await Promise.all([
      read(authority, "discovery-review-list", { cursor: null, limit: 100 }, requestId),
      routeId === "review" ? read(authority, "tracker-list", {}, requestId) : Promise.resolve([])
    ]);
    const opportunities = pageItems(reviewPage);
    const attempts = records(attemptsResult);
    const pendingDiscovery = opportunities.filter((item) => item["status"] !== "ready");
    const pendingAttempts = attempts.filter((item) => domainValue(item)["status"] !== "confirmed");
    const payload = basePayload(routeId === "discovery"
      ? "Bounded opportunity projections from governed discovery evidence."
      : "Discovery and application records requiring human review.");
    payload.metrics = [
      metric("records", "Opportunity records", opportunities.length, "Bounded page from vocationd"),
      metric("live", "Live", opportunities.filter((item) => item["liveness"] === "live").length),
      metric("review", "Needs review", pendingDiscovery.length + pendingAttempts.length)
    ];
    payload.items = routeId === "discovery"
      ? opportunities.map(discoveryReviewItem)
      : [...pendingDiscovery.map(discoveryReviewItem), ...pendingAttempts.slice(0, 50).map(trackerItem)];
    payload.details = [
      { label: "Truth policy", value: "Unresolved fields remain unresolved" },
      { label: "Dedupe policy", value: "Ambiguous identity remains a review proposal" },
      { label: "Page limit", value: "100 opportunities" }
    ];
    return payload;
  }

  if (routeId === "twin" || routeId === "documents") {
    const domain = routeId === "twin" ? "profiles" : "documents";
    const values = records(await read(authority, "domain-list", { domain }, requestId));
    const payload = basePayload(routeId === "twin"
      ? "Temporal career profile snapshots held by the local authority."
      : "Claim-bound document artifacts and their authority versions.");
    payload.metrics = [metric("records", routeId === "twin" ? "Twin snapshots" : "Documents", values.length)];
    payload.items = values.map((value) => genericDomainItem(
      value,
      routeId === "twin" ? ["label", "name", "twinId"] : ["title", "documentId"],
      routeId === "twin" ? ["profileId", "twinId"] : ["documentType", "locale"]
    ));
    return payload;
  }

  if (routeId === "pipeline") {
    const attempts = records(await read(authority, "tracker-list", {}, requestId));
    const payload = basePayload("Application attempts and verified lifecycle state from the tracker authority.");
    payload.metrics = [
      metric("attempts", "Attempts", attempts.length),
      metric("confirmed", "Confirmed", attempts.filter((item) => domainValue(item)["status"] === "confirmed").length),
      metric("blocked", "Blocked", attempts.filter((item) => domainValue(item)["status"] === "blocked").length)
    ];
    payload.items = attempts.map(trackerItem);
    return payload;
  }

  if (routeId === "evidence") {
    const artifacts = records(await read(authority, "artifact-list", {}, requestId));
    const payload = basePayload("Encrypted artifacts available to evidence-bound product workflows.");
    payload.metrics = [metric("artifacts", "Artifacts", artifacts.length, "Content addressed")];
    payload.items = artifacts.map((artifact) => genericDomainItem(artifact, ["fileName", "artifactId"], ["mediaType", "kind"]));
    return payload;
  }

  if (routeId === "approvals") {
    const approvers = records(await read(authority, "approver-list", {}, requestId));
    const payload = basePayload("Trusted human authorization identities registered with the local authority.");
    payload.metrics = [metric("approvers", "Trusted approvers", approvers.length)];
    payload.items = approvers.map((approver) => genericDomainItem(approver, ["approvedBy", "keyId"], ["role", "status"]));
    return payload;
  }

  if (routeId === "audit") {
    const audit = await read(authority, "audit-export", {}, requestId);
    const auditRecord = isRecord(audit) ? audit : {};
    const payload = basePayload("Authenticated audit export status and event-chain evidence.");
    payload.metrics = [metric("events", "Events", numberValue(auditRecord["eventCount"]), "Hash chained")];
    payload.details = [
      field("Chain head", auditRecord["chainHead"]),
      field("Checkpoint", auditRecord["checkpointId"]),
      field("Generated", auditRecord["generatedAt"])
    ];
    return payload;
  }

  if (routeId === "credentials") {
    const passports = await readDecisionDetails(
      authority,
      "credential-passport-list",
      "credential-passport-get",
      requestId
    );
    const items = passports.map(credentialItem);
    const payload = basePayload("Credential Passport verification summaries from encrypted local authority records.");
    payload.metrics = [
      metric("passports", "Credentials", items.length, "Bounded to 25 records"),
      metric("verified", "Verified proofs", items.filter((item) => item.status === "verified").length),
      metric("review", "Incomplete or rejected", items.filter((item) => item.status !== "verified").length)
    ];
    payload.items = items;
    payload.details = [
      { label: "Storage", value: "Encrypted artifact vault" },
      { label: "Interpretation", value: "Proof verification does not certify the underlying real-world claim" }
    ];
    return payload;
  }

  if (routeId === "interview" || routeId === "offers") {
    const outcomes = records(await read(authority, "outcome-list", { includeArchived: false }, requestId));
    const stages = routeId === "interview" ? new Set(["screen", "interview"]) : new Set(["offer", "accepted"]);
    const selected = outcomes.filter((outcome) => stages.has(stringValue(domainValue(outcome)["stage"], "")));
    const payload = basePayload(routeId === "interview"
      ? "Recorded screen and interview outcomes. No live audio session is implied."
      : "Recorded offer and acceptance outcomes for evidence-bound comparison.");
    payload.metrics = [metric("outcomes", "Relevant outcomes", selected.length)];
    payload.items = selected.map((outcome) => genericDomainItem(outcome, ["stage", "outcomeId"], ["opportunityId", "source"]));
    payload.details = routeId === "interview"
      ? [
        { label: "Preparation", value: "Evidence-bound story planning and structured debrief" },
        { label: "Audio", value: "No live transcription session is active" }
      ]
      : [
        { label: "Analysis", value: "Compensation, BATNA, relocation, and uncertainty scenarios" },
        { label: "Boundary", value: "Legal, tax, visa, and licensing conclusions require specialists" }
      ];
    return payload;
  }

  if (routeId === "settings") {
    const [health, autoApply, onboarding] = await Promise.all([
      read(authority, "health", {}, requestId),
      read(authority, "auto-apply-status", {}, requestId),
      read(authority, "onboarding-status", {}, requestId)
    ]);
    const healthRecord = isRecord(health) ? health : {};
    const autoRecord = isRecord(autoApply) ? autoApply : {};
    const onboardingRecord = isRecord(onboarding) ? onboarding : {};
    const payload = basePayload("Local runtime, safety, and onboarding configuration from vocationd.");
    payload.metrics = [
      metric("daemon", "Daemon", stringValue(healthRecord["status"], "Reachable")),
      metric("mode", "Automation mode", stringValue(autoRecord["mode"], "Manual")),
      metric("onboarding", "Onboarding", stringValue(onboardingRecord["status"], "Not started"))
    ];
    payload.details = [
      field("Kill switch", autoRecord["killSwitchEngaged"], "State not exposed"),
      { label: "Network", value: "Governed egress only" }
    ];
    payload.actions = [{
      id: "engage-kill-switch",
      label: "Engage kill switch",
      endpoint: "/api/safety/kill",
      capability: "safety.kill",
      approvalId: null,
      tone: "danger",
      requiresConfirmation: true
    }];
    return payload;
  }

  throw new Error(`Unsupported workbench route: ${routeId}`);
}
