import { randomUUID } from "node:crypto";
import { sha256, stableStringify } from "./hash.js";
import { assertSchema } from "./schema.js";
import type { Confidence, EvidenceStatus } from "./types.js";

export const CAREER_FACT_CATEGORIES = [
  "skill",
  "credential",
  "experience",
  "artifact",
  "value",
  "constraint",
  "preference",
  "health-boundary",
  "financial-runway",
  "family-impact",
  "work-authorization",
  "licensing",
  "network",
  "reputation",
  "career-narrative"
] as const;

export const CAREER_FACT_USES = [
  "analysis",
  "cv",
  "outreach",
  "application",
  "interview",
  "public-profile"
] as const;

export type CareerFactCategory = (typeof CAREER_FACT_CATEGORIES)[number];
export type CareerFactUse = (typeof CAREER_FACT_USES)[number];
export type FactSensitivity = "public" | "internal" | "sensitive";
export type FactValue = string | number | boolean | string[] | Record<string, string | number | boolean | null>;

export interface TemporalCareerFact {
  factId: string;
  category: CareerFactCategory;
  label: string;
  value: FactValue;
  claimId?: string;
  validFrom: string;
  validTo?: string;
  observedAt: string;
  evidenceStatus: EvidenceStatus;
  sourcePointer: string;
  confidence: Confidence;
  sensitivity: FactSensitivity;
  allowedUses: CareerFactUse[];
}

export interface CareerGoal {
  goalId: string;
  label: string;
  horizon: "immediate" | "one-year" | "three-year" | "long-term";
  priority: number;
  status: "active" | "paused" | "achieved" | "retired";
}

export interface CareerTwin {
  twinId: string;
  profileScope: "synthetic" | "local-private";
  twinVersion: number;
  createdAt: string;
  updatedAt: string;
  facts: TemporalCareerFact[];
  goals: CareerGoal[];
}

export interface CareerTwinValidation {
  valid: boolean;
  reasons: string[];
  snapshotHash: string;
}

export function createCareerTwin(
  profileScope: CareerTwin["profileScope"],
  facts: TemporalCareerFact[] = [],
  goals: CareerGoal[] = [],
  now = new Date()
): CareerTwin {
  const twin: CareerTwin = {
    twinId: `${profileScope === "synthetic" ? "DEMO" : "LOCAL"}-TWIN-${randomUUID().toUpperCase()}`,
    profileScope,
    twinVersion: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    facts,
    goals
  };
  const validation = validateCareerTwin(twin);
  if (!validation.valid) throw new Error(`Career twin validation failed: ${validation.reasons.join(", ")}`);
  return twin;
}

export function careerTwinSnapshotHash(twin: CareerTwin): string {
  return sha256(stableStringify(twin));
}

export function validateCareerTwin(twin: CareerTwin): CareerTwinValidation {
  assertSchema("career-twin", twin);
  const reasons: string[] = [];
  const factIds = new Set<string>();
  const goalIds = new Set<string>();

  for (const fact of twin.facts) {
    if (factIds.has(fact.factId)) reasons.push(`duplicate-fact:${fact.factId}`);
    factIds.add(fact.factId);
    const from = Date.parse(fact.validFrom);
    const to = fact.validTo ? Date.parse(fact.validTo) : null;
    const observed = Date.parse(fact.observedAt);
    if (!Number.isFinite(from) || !Number.isFinite(observed) || (to !== null && !Number.isFinite(to))) {
      reasons.push(`invalid-fact-date:${fact.factId}`);
    } else if (to !== null && to < from) {
      reasons.push(`invalid-validity-window:${fact.factId}`);
    }
    if (fact.sensitivity === "sensitive" && fact.allowedUses.includes("public-profile")) {
      reasons.push(`sensitive-public-use:${fact.factId}`);
    }
    if (fact.evidenceStatus === "verified" && !fact.sourcePointer.trim()) {
      reasons.push(`verified-fact-source-missing:${fact.factId}`);
    }
    if (fact.allowedUses.length === 0) reasons.push(`fact-use-missing:${fact.factId}`);
  }

  for (const goal of twin.goals) {
    if (goalIds.has(goal.goalId)) reasons.push(`duplicate-goal:${goal.goalId}`);
    goalIds.add(goal.goalId);
  }

  return { valid: reasons.length === 0, reasons, snapshotHash: careerTwinSnapshotHash(twin) };
}

export function currentFacts(twin: CareerTwin, at = new Date()): TemporalCareerFact[] {
  const timestamp = at.getTime();
  return twin.facts.filter((fact) => {
    const from = Date.parse(fact.validFrom);
    const to = fact.validTo ? Date.parse(fact.validTo) : Number.POSITIVE_INFINITY;
    return from <= timestamp && timestamp <= to;
  });
}
