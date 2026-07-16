import { sha256, stableStringify } from "../hash.js";
import type { JsonValue } from "./source-observation.js";

export const OPPORTUNITY_TRUTH_STATES = [
  "observed",
  "inferred",
  "consistent",
  "conflicting",
  "stale",
  "unresolved"
] as const;

export const OPPORTUNITY_TRUTH_FIELDS = [
  "salary",
  "remoteConditions",
  "workAuthorization",
  "licensing",
  "location",
  "deadline"
] as const;

export type OpportunityTruthState = (typeof OPPORTUNITY_TRUTH_STATES)[number];
export type OpportunityTruthFieldName = (typeof OPPORTUNITY_TRUTH_FIELDS)[number];

export interface OpportunityTruthEvidencePointer {
  readonly observationId: string;
  readonly pointer: string;
  readonly observedAt: string;
}

export interface OpportunityTruthRecencyPolicy {
  readonly policyId: string;
  readonly maxAgeMs: number;
  readonly maxFutureSkewMs: number;
  readonly onExpiry: "stale";
}

export interface OpportunityFieldTruthInput {
  readonly state: OpportunityTruthState;
  readonly value: JsonValue;
  readonly evidence: readonly OpportunityTruthEvidencePointer[];
  readonly observedAt: string;
  readonly recencyPolicy: OpportunityTruthRecencyPolicy;
  readonly rationale: string;
}

export interface OpportunityFieldTruth extends OpportunityFieldTruthInput {}

export interface OpportunityTruthRecordInput {
  readonly opportunityKey: string;
  readonly assessedAt: string;
  readonly mandatoryFields: readonly OpportunityTruthFieldName[];
  readonly fields: Readonly<Record<OpportunityTruthFieldName, OpportunityFieldTruthInput>>;
}

export type OpportunityTruthBlockerCode =
  | "conflicting-evidence"
  | "mandatory-unresolved"
  | "mandatory-stale";

export interface OpportunityTruthBlocker {
  readonly field: OpportunityTruthFieldName;
  readonly code: OpportunityTruthBlockerCode;
}

export interface OpportunityTruthRecord {
  readonly schemaVersion: "1.0.0";
  readonly truthRecordId: string;
  readonly opportunityKey: string;
  readonly assessedAt: string;
  readonly mandatoryFields: readonly OpportunityTruthFieldName[];
  readonly fields: Readonly<Record<OpportunityTruthFieldName, OpportunityFieldTruth>>;
  readonly disposition: "actionable" | "blocked";
  readonly blockers: readonly OpportunityTruthBlocker[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO date-time`);
  }
  return value;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, nextAncestors));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, entry]) => key.length > 0 && entry !== undefined && isJsonValue(entry, nextAncestors)
  );
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)]))
    ) as { readonly [key: string]: JsonValue };
  }
  return value;
}

function canonicalRecencyPolicy(policy: OpportunityTruthRecencyPolicy): OpportunityTruthRecencyPolicy {
  if (!/^[a-z][a-z0-9._:-]{1,127}$/.test(policy.policyId)) {
    throw new Error("Truth recency policyId is invalid");
  }
  if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 1 || policy.maxAgeMs > 365 * 86_400_000) {
    throw new Error("Truth recency maxAgeMs is outside the supported range");
  }
  if (
    !Number.isSafeInteger(policy.maxFutureSkewMs) ||
    policy.maxFutureSkewMs < 0 ||
    policy.maxFutureSkewMs > 24 * 60 * 60_000
  ) {
    throw new Error("Truth recency maxFutureSkewMs is outside the supported range");
  }
  if (policy.onExpiry !== "stale") throw new Error("Truth recency policy must mark expired evidence stale");
  return Object.freeze({ ...policy });
}

function canonicalEvidence(
  evidence: readonly OpportunityTruthEvidencePointer[]
): readonly OpportunityTruthEvidencePointer[] {
  if (evidence.length === 0 || evidence.length > 64) throw new Error("Truth fields require bounded evidence pointers");
  const normalized = evidence.map((item) => {
    if (!/^OBS-[A-F0-9]{32}$/.test(item.observationId)) throw new Error("Truth evidence observationId is invalid");
    const pointer = item.pointer.trim();
    if (!pointer || pointer.length > 2_048 || /[\0\r\n]/.test(pointer)) {
      throw new Error("Truth evidence pointer is invalid");
    }
    return Object.freeze({
      observationId: item.observationId,
      pointer,
      observedAt: canonicalTimestamp(item.observedAt, "Truth evidence observedAt")
    });
  }).sort((left, right) =>
    compareText(left.observedAt, right.observedAt) ||
    compareText(left.observationId, right.observationId) ||
    compareText(left.pointer, right.pointer)
  );
  const identities = normalized.map((item) => `${item.observationId}\0${item.pointer}\0${item.observedAt}`);
  if (new Set(identities).size !== identities.length) throw new Error("Truth evidence pointers must be unique");
  return Object.freeze(normalized);
}

function canonicalField(
  fieldName: OpportunityTruthFieldName,
  input: OpportunityFieldTruthInput,
  assessedAt: string
): OpportunityFieldTruth {
  if (!(OPPORTUNITY_TRUTH_STATES as readonly string[]).includes(input.state)) {
    throw new Error(`Truth state is invalid for ${fieldName}`);
  }
  if (!isJsonValue(input.value)) throw new Error(`Truth value is not JSON-safe for ${fieldName}`);
  const evidence = canonicalEvidence(input.evidence);
  const observedAt = canonicalTimestamp(input.observedAt, `${fieldName}.observedAt`);
  const latestEvidenceAt = evidence.reduce(
    (latest, item) => compareText(item.observedAt, latest) > 0 ? item.observedAt : latest,
    evidence[0]!.observedAt
  );
  if (observedAt !== latestEvidenceAt) {
    throw new Error(`${fieldName}.observedAt must equal the newest evidence timestamp`);
  }
  const recencyPolicy = canonicalRecencyPolicy(input.recencyPolicy);
  const ageMs = Date.parse(assessedAt) - Date.parse(observedAt);
  if (ageMs < -recencyPolicy.maxFutureSkewMs) throw new Error(`${fieldName} evidence is too far in the future`);
  let state = input.state;
  if (["observed", "inferred", "consistent"].includes(state) && ageMs > recencyPolicy.maxAgeMs) state = "stale";
  if (state === "stale" && ageMs <= recencyPolicy.maxAgeMs && input.state === "stale") {
    throw new Error(`${fieldName} cannot claim stale before its recency policy expires`);
  }
  if (["observed", "inferred", "consistent"].includes(state) && input.value === null) {
    throw new Error(`${fieldName} requires a value in state ${state}`);
  }
  if ((state === "conflicting" || state === "unresolved") && input.value !== null) {
    throw new Error(`${fieldName} must not claim a value in state ${state}`);
  }
  if ((state === "consistent" || state === "conflicting") && evidence.length < 2) {
    throw new Error(`${fieldName} requires at least two evidence pointers in state ${state}`);
  }
  const rationale = input.rationale.trim().replace(/\s+/g, " ");
  if (!rationale || rationale.length > 2_000 || /\0/.test(rationale)) {
    throw new Error(`${fieldName} truth rationale is invalid`);
  }
  return Object.freeze({
    state,
    value: freezeJson(input.value),
    evidence,
    observedAt,
    recencyPolicy,
    rationale
  });
}

function blockersFor(
  fields: Readonly<Record<OpportunityTruthFieldName, OpportunityFieldTruth>>,
  mandatoryFields: readonly OpportunityTruthFieldName[]
): readonly OpportunityTruthBlocker[] {
  const mandatory = new Set(mandatoryFields);
  const blockers: OpportunityTruthBlocker[] = [];
  for (const field of OPPORTUNITY_TRUTH_FIELDS) {
    const state = fields[field].state;
    if (state === "conflicting") blockers.push({ field, code: "conflicting-evidence" });
    if (mandatory.has(field) && state === "unresolved") blockers.push({ field, code: "mandatory-unresolved" });
    if (mandatory.has(field) && state === "stale") blockers.push({ field, code: "mandatory-stale" });
  }
  return Object.freeze(blockers.map((blocker) => Object.freeze(blocker)));
}

export function createOpportunityTruthRecord(input: OpportunityTruthRecordInput): OpportunityTruthRecord {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(input.opportunityKey)) {
    throw new Error("Opportunity truth key is invalid");
  }
  const assessedAt = canonicalTimestamp(input.assessedAt, "Truth record assessedAt");
  const mandatoryFields = [...new Set(input.mandatoryFields)].sort(compareText);
  if (mandatoryFields.length !== input.mandatoryFields.length) throw new Error("Mandatory truth fields must be unique");
  if (mandatoryFields.some((field) => !(OPPORTUNITY_TRUTH_FIELDS as readonly string[]).includes(field))) {
    throw new Error("Mandatory truth field is invalid");
  }
  const inputKeys = Object.keys(input.fields).sort(compareText);
  const expectedKeys = [...OPPORTUNITY_TRUTH_FIELDS].sort(compareText);
  if (stableStringify(inputKeys) !== stableStringify(expectedKeys)) {
    throw new Error("Opportunity truth record must contain exactly the approved six fields");
  }
  const fields = Object.fromEntries(
    OPPORTUNITY_TRUTH_FIELDS.map((field) => [field, canonicalField(field, input.fields[field], assessedAt)])
  ) as unknown as Readonly<Record<OpportunityTruthFieldName, OpportunityFieldTruth>>;
  const blockers = blockersFor(fields, mandatoryFields);
  const core = {
    opportunityKey: input.opportunityKey,
    assessedAt,
    mandatoryFields: Object.freeze(mandatoryFields),
    fields: Object.freeze(fields),
    disposition: blockers.length === 0 ? "actionable" as const : "blocked" as const,
    blockers
  };
  const digest = sha256(stableStringify(core)).slice("sha256:".length, "sha256:".length + 32).toUpperCase();
  return Object.freeze({
    schemaVersion: "1.0.0",
    truthRecordId: `TRUTH-${digest}`,
    ...core
  });
}

export function assertOpportunityTruthRecord(record: OpportunityTruthRecord): void {
  if (record.schemaVersion !== "1.0.0" || !/^TRUTH-[A-F0-9]{32}$/.test(record.truthRecordId)) {
    throw new Error("Opportunity truth record envelope is invalid");
  }
  const rebuilt = createOpportunityTruthRecord({
    opportunityKey: record.opportunityKey,
    assessedAt: record.assessedAt,
    mandatoryFields: record.mandatoryFields,
    fields: record.fields
  });
  if (stableStringify(rebuilt) !== stableStringify(record)) throw new Error("Opportunity truth record integrity check failed");
}

export function assertOpportunityTruthRecordActionable(record: OpportunityTruthRecord): void {
  assertOpportunityTruthRecord(record);
  if (record.disposition !== "actionable" || record.blockers.length > 0) {
    throw new Error(`Opportunity truth record fails closed: ${record.blockers.map((item) => item.code).join(", ")}`);
  }
}

