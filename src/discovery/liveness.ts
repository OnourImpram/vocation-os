import { sha256, stableStringify } from "../hash.js";
import {
  assertSourceObservation,
  type SourceObservation
} from "./source-observation.js";

export const LIVENESS_STATES = ["live", "closed", "stale", "unreachable", "unresolved"] as const;
export type LivenessState = (typeof LIVENESS_STATES)[number];

export interface LivenessPolicy {
  readonly maxLiveAgeMs: number;
  readonly maxNegativeAgeMs: number;
  readonly closedConfirmationCount: number;
  readonly maxFutureSkewMs: number;
}

export interface LivenessAssessment {
  readonly schemaVersion: "1.0.0";
  readonly assessmentId: string;
  readonly sourceKey: string | null;
  readonly state: LivenessState;
  readonly confidence: "high" | "medium" | "low";
  readonly assessedAt: string;
  readonly evidenceObservationIds: readonly string[];
  readonly reasons: readonly string[];
}

export const DEFAULT_LIVENESS_POLICY: Readonly<LivenessPolicy> = Object.freeze({
  maxLiveAgeMs: 24 * 60 * 60_000,
  maxNegativeAgeMs: 12 * 60 * 60_000,
  closedConfirmationCount: 2,
  maxFutureSkewMs: 5 * 60_000
});

const NEGATIVE_STATES = new Set(["not-found", "gone"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalNow(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Liveness assessment time is invalid");
  return now.toISOString();
}

function assertPolicy(policy: Readonly<LivenessPolicy>): void {
  for (const [name, value] of [
    ["maxLiveAgeMs", policy.maxLiveAgeMs],
    ["maxNegativeAgeMs", policy.maxNegativeAgeMs],
    ["maxFutureSkewMs", policy.maxFutureSkewMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 90 * 86_400_000) {
      throw new Error(`${name} is outside the supported liveness policy range`);
    }
  }
  if (
    !Number.isSafeInteger(policy.closedConfirmationCount) ||
    policy.closedConfirmationCount < 1 ||
    policy.closedConfirmationCount > 10
  ) {
    throw new Error("closedConfirmationCount must be between 1 and 10");
  }
}

function compareNewest(left: SourceObservation, right: SourceObservation): number {
  const timeDifference = Date.parse(right.observedAt) - Date.parse(left.observedAt);
  if (timeDifference !== 0) return timeDifference;
  return left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0;
}

function preservedUncertainty(observations: readonly SourceObservation[]): readonly string[] {
  return [...new Set(observations.flatMap((observation) => observation.uncertainty))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function assessment(
  sourceKey: string | null,
  state: LivenessState,
  confidence: LivenessAssessment["confidence"],
  assessedAt: string,
  evidenceObservationIds: readonly string[],
  reasons: readonly string[]
): LivenessAssessment {
  const core = {
    sourceKey,
    state,
    confidence,
    assessedAt,
    evidenceObservationIds: Object.freeze([...evidenceObservationIds]),
    reasons: Object.freeze([...reasons])
  };
  const digest = sha256(stableStringify(core)).slice("sha256:".length, "sha256:".length + 32).toUpperCase();
  return Object.freeze({
    schemaVersion: "1.0.0",
    assessmentId: `LIVE-${digest}`,
    ...core
  });
}

export function assessSourceLiveness(
  observations: readonly SourceObservation[],
  policy: Readonly<LivenessPolicy> = DEFAULT_LIVENESS_POLICY,
  now = new Date()
): LivenessAssessment {
  assertPolicy(policy);
  const assessedAt = canonicalNow(now);
  if (observations.length === 0) {
    return assessment(null, "unresolved", "low", assessedAt, [], ["No source observations are available"]);
  }
  for (const observation of observations) assertSourceObservation(observation);
  const sourceKeys = new Set(observations.map((observation) => observation.sourceKey));
  if (sourceKeys.size !== 1) throw new Error("Liveness assessment cannot mix source keys");

  const sorted = [...observations].sort(compareNewest);
  const latest = sorted[0]!;
  const latestAgeMs = now.getTime() - Date.parse(latest.observedAt);
  if (latestAgeMs < -policy.maxFutureSkewMs) {
    return assessment(
      latest.sourceKey,
      "unresolved",
      "low",
      assessedAt,
      [latest.observationId],
      ["The newest observation is too far in the future"]
    );
  }

  if (latest.availability === "available") {
    if (latest.uncertainty.includes("application-endpoint-missing")) {
      return assessment(
        latest.sourceKey,
        "unresolved",
        "low",
        assessedAt,
        [latest.observationId],
        ["The source is available, but no valid application endpoint was observed", ...latest.uncertainty]
      );
    }
    if (latestAgeMs > policy.maxLiveAgeMs) {
      return assessment(
        latest.sourceKey,
        "stale",
        "low",
        assessedAt,
        [latest.observationId],
        ["The newest positive observation exceeds the live evidence age limit"]
      );
    }
    return assessment(
      latest.sourceKey,
      "live",
      latest.uncertainty.length === 0 ? "high" : "medium",
      assessedAt,
      [latest.observationId],
      latest.uncertainty.length === 0
        ? ["A current successful source observation confirms availability"]
        : ["Availability is current, but extraction uncertainty remains", ...latest.uncertainty]
    );
  }

  if (NEGATIVE_STATES.has(latest.availability)) {
    if (latestAgeMs > policy.maxNegativeAgeMs) {
      return assessment(
        latest.sourceKey,
        "stale",
        "low",
        assessedAt,
        [latest.observationId],
        ["The newest negative observation exceeds the negative evidence age limit", ...latest.uncertainty]
      );
    }
    const consecutive: SourceObservation[] = [];
    const observedTimes = new Set<string>();
    for (const observation of sorted) {
      if (!NEGATIVE_STATES.has(observation.availability)) break;
      const observationAgeMs = now.getTime() - Date.parse(observation.observedAt);
      if (observationAgeMs > policy.maxNegativeAgeMs || observationAgeMs < -policy.maxFutureSkewMs) break;
      if (!observedTimes.has(observation.observedAt)) {
        consecutive.push(observation);
        observedTimes.add(observation.observedAt);
      }
    }
    const evidence = consecutive
      .slice(0, policy.closedConfirmationCount)
      .map((observation) => observation.observationId);
    if (consecutive.length >= policy.closedConfirmationCount) {
      return assessment(
        latest.sourceKey,
        "closed",
        "high",
        assessedAt,
        evidence,
        [
          `${policy.closedConfirmationCount} consecutive negative observations confirm closure`,
          ...preservedUncertainty(consecutive.slice(0, policy.closedConfirmationCount))
        ]
      );
    }
    return assessment(
      latest.sourceKey,
      "unresolved",
      "low",
      assessedAt,
      evidence,
      [
        `Only ${consecutive.length} of ${policy.closedConfirmationCount} required closure confirmations are available`,
        ...preservedUncertainty(consecutive)
      ]
    );
  }

  const unreachable = new Set(["access-denied", "rate-limited", "transport-error"]).has(latest.availability);
  return assessment(
    latest.sourceKey,
    unreachable ? "unreachable" : "unresolved",
    "low",
    assessedAt,
    [latest.observationId],
    [
      `The newest observation is ${latest.availability}, which cannot establish posting availability`,
      ...latest.uncertainty
    ]
  );
}

export function assertLivenessAssessment(value: unknown): asserts value is LivenessAssessment {
  if (!isRecord(value)) throw new Error("Liveness assessment must be an object");
  const expectedKeys = [
    "schemaVersion",
    "assessmentId",
    "sourceKey",
    "state",
    "confidence",
    "assessedAt",
    "evidenceObservationIds",
    "reasons"
  ].sort();
  if (stableStringify(Object.keys(value).sort()) !== stableStringify(expectedKeys)) {
    throw new Error("Liveness assessment envelope contains unexpected or missing fields");
  }
  if (value["schemaVersion"] !== "1.0.0" || typeof value["assessmentId"] !== "string") {
    throw new Error("Liveness assessment envelope is invalid");
  }
  if (!(LIVENESS_STATES as readonly unknown[]).includes(value["state"])) {
    throw new Error("Liveness assessment state is invalid");
  }
  if (!["high", "medium", "low"].includes(value["confidence"] as string)) {
    throw new Error("Liveness assessment confidence is invalid");
  }
  const sourceKey = value["sourceKey"];
  if (
    sourceKey !== null &&
    (typeof sourceKey !== "string" || !sourceKey.trim() || sourceKey.length > 512 || /\0/.test(sourceKey))
  ) {
    throw new Error("Liveness assessment sourceKey is invalid");
  }
  if (typeof value["assessedAt"] !== "string") throw new Error("Liveness assessment time is invalid");
  const assessedTimestamp = Date.parse(value["assessedAt"]);
  if (!Number.isFinite(assessedTimestamp) || new Date(assessedTimestamp).toISOString() !== value["assessedAt"]) {
    throw new Error("Liveness assessment time must be canonical ISO date-time");
  }
  const evidence = value["evidenceObservationIds"];
  if (
    !Array.isArray(evidence) ||
    evidence.some((id) => typeof id !== "string" || !/^OBS-[A-F0-9]{32}$/.test(id)) ||
    new Set(evidence).size !== evidence.length
  ) {
    throw new Error("Liveness assessment evidence identities are invalid");
  }
  const reasons = value["reasons"];
  if (
    !Array.isArray(reasons) ||
    reasons.length === 0 ||
    reasons.some((reason) => typeof reason !== "string" || !reason.trim() || reason.length > 1_024 || /\0/.test(reason)) ||
    new Set(reasons).size !== reasons.length
  ) {
    throw new Error("Liveness assessment reasons are invalid");
  }
  const rebuilt = assessment(
    sourceKey,
    value["state"] as LivenessState,
    value["confidence"] as LivenessAssessment["confidence"],
    value["assessedAt"],
    evidence as string[],
    reasons as string[]
  );
  if (stableStringify(rebuilt) !== stableStringify(value)) {
    throw new Error("Liveness assessment integrity check failed");
  }
}
