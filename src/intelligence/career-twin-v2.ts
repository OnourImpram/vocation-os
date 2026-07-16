import { sha256, stableStringify } from "../hash.js";
import {
  currentFacts,
  validateCareerTwin,
  type CareerGoal,
  type CareerTwin,
  type TemporalCareerFact
} from "../career-twin.js";

export interface CareerTwinSnapshot {
  schemaVersion: 2;
  snapshotId: string;
  twinId: string;
  twinVersion: number;
  effectiveAt: string;
  generatedAt: string;
  facts: TemporalCareerFact[];
  goals: CareerGoal[];
  sourceTwinHash: string;
  snapshotHash: string;
}

export interface CareerTwinDiff {
  fromSnapshotId: string;
  toSnapshotId: string;
  addedFactIds: string[];
  removedFactIds: string[];
  changedFactIds: string[];
  activatedGoalIds: string[];
  retiredGoalIds: string[];
}

export interface CounterfactualRoute {
  routeId: string;
  label: string;
  horizonMonths: number;
  opens: string[];
  closes: string[];
  strengthenedFactIds: string[];
  weakenedFactIds: string[];
  hardDefeaters: string[];
  uncertaintyDrivers: string[];
  evidencePointers: string[];
  reversibleUntil: string | null;
}

export interface CounterfactualRouteAnalysis {
  routeId: string;
  sourceSnapshotId: string;
  horizonMonths: number;
  optionalityDelta: number;
  openedPathCount: number;
  closedPathCount: number;
  decisionStatus: "blocked" | "review" | "eligible";
  hardDefeaters: string[];
  uncertaintyDrivers: string[];
  evidencePointers: string[];
  reversibleUntil: string | null;
  analysisHash: string;
}

function assertIsoDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid ISO date`);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function valueHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function createCareerTwinSnapshot(
  twin: CareerTwin,
  effectiveAt = new Date(),
  generatedAt = new Date()
): CareerTwinSnapshot {
  const validation = validateCareerTwin(twin);
  if (!validation.valid) throw new Error(`Career twin validation failed: ${validation.reasons.join(", ")}`);
  const effectiveAtIso = effectiveAt.toISOString();
  const generatedAtIso = generatedAt.toISOString();
  const facts = currentFacts(twin, effectiveAt)
    .map((fact) => ({ ...fact, allowedUses: [...fact.allowedUses] }))
    .sort((left, right) => left.factId.localeCompare(right.factId));
  const goals = twin.goals
    .filter((goal) => goal.status === "active" || goal.status === "paused")
    .map((goal) => ({ ...goal }))
    .sort((left, right) => left.goalId.localeCompare(right.goalId));
  const sourceTwinHash = validation.snapshotHash;
  const snapshotBody = {
    schemaVersion: 2 as const,
    twinId: twin.twinId,
    twinVersion: twin.twinVersion,
    effectiveAt: effectiveAtIso,
    generatedAt: generatedAtIso,
    facts,
    goals,
    sourceTwinHash
  };
  const snapshotHash = valueHash(snapshotBody);
  return {
    ...snapshotBody,
    snapshotId: `CTS-${snapshotHash.slice("sha256:".length, "sha256:".length + 24).toUpperCase()}`,
    snapshotHash
  };
}

export function diffCareerTwinSnapshots(
  from: CareerTwinSnapshot,
  to: CareerTwinSnapshot
): CareerTwinDiff {
  if (from.twinId !== to.twinId) throw new Error("Career twin snapshots belong to different twins");
  const fromFacts = new Map(from.facts.map((fact) => [fact.factId, fact]));
  const toFacts = new Map(to.facts.map((fact) => [fact.factId, fact]));
  const fromGoals = new Map(from.goals.map((goal) => [goal.goalId, goal]));
  const toGoals = new Map(to.goals.map((goal) => [goal.goalId, goal]));
  const addedFactIds = [...toFacts.keys()].filter((id) => !fromFacts.has(id)).sort();
  const removedFactIds = [...fromFacts.keys()].filter((id) => !toFacts.has(id)).sort();
  const changedFactIds = [...toFacts.keys()]
    .filter((id) => fromFacts.has(id) && valueHash(fromFacts.get(id)) !== valueHash(toFacts.get(id)))
    .sort();
  const activatedGoalIds = [...toGoals.keys()]
    .filter((id) => !fromGoals.has(id) || fromGoals.get(id)?.status !== toGoals.get(id)?.status)
    .sort();
  const retiredGoalIds = [...fromGoals.keys()].filter((id) => !toGoals.has(id)).sort();
  return {
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    addedFactIds,
    removedFactIds,
    changedFactIds,
    activatedGoalIds,
    retiredGoalIds
  };
}

export function analyzeCounterfactualRoute(
  snapshot: CareerTwinSnapshot,
  route: CounterfactualRoute
): CounterfactualRouteAnalysis {
  if (!route.routeId.trim() || !route.label.trim()) throw new Error("Counterfactual route identity is required");
  if (!Number.isInteger(route.horizonMonths) || route.horizonMonths < 1 || route.horizonMonths > 120) {
    throw new Error("Counterfactual route horizon must be an integer from 1 to 120 months");
  }
  if (route.reversibleUntil !== null) assertIsoDate(route.reversibleUntil, "Counterfactual reversibleUntil");
  const factIds = new Set(snapshot.facts.map((fact) => fact.factId));
  const missingFactReferences = [...route.strengthenedFactIds, ...route.weakenedFactIds]
    .filter((factId) => !factIds.has(factId));
  if (missingFactReferences.length > 0) {
    throw new Error(`Counterfactual route references unknown facts: ${uniqueSorted(missingFactReferences).join(", ")}`);
  }
  const opens = uniqueSorted(route.opens);
  const closes = uniqueSorted(route.closes);
  const hardDefeaters = uniqueSorted(route.hardDefeaters);
  const uncertaintyDrivers = uniqueSorted(route.uncertaintyDrivers);
  const evidencePointers = uniqueSorted(route.evidencePointers);
  if (evidencePointers.length === 0) throw new Error("Counterfactual route requires evidence pointers");
  const optionalityDelta = opens.length - closes.length;
  const decisionStatus: CounterfactualRouteAnalysis["decisionStatus"] = hardDefeaters.length > 0
    ? "blocked"
    : uncertaintyDrivers.length > 0
      ? "review"
      : "eligible";
  const body = {
    routeId: route.routeId,
    sourceSnapshotId: snapshot.snapshotId,
    horizonMonths: route.horizonMonths,
    optionalityDelta,
    openedPathCount: opens.length,
    closedPathCount: closes.length,
    decisionStatus,
    hardDefeaters,
    uncertaintyDrivers,
    evidencePointers,
    reversibleUntil: route.reversibleUntil
  };
  return { ...body, analysisHash: valueHash(body) };
}
