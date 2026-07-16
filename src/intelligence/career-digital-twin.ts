import { currentFacts, validateCareerTwin, type CareerGoal, type CareerTwin, type TemporalCareerFact } from "../career-twin.js";
import { sha256, stableStringify } from "../hash.js";
import {
  assertEvidenceRefs,
  intelligenceAssertion,
  uniqueEvidenceRefs,
  type IntelligenceAssertion
} from "./assertions.js";

export const CAREER_FACT_DIFF_FIELDS = [
  "category",
  "label",
  "value",
  "claimId",
  "validFrom",
  "validTo",
  "observedAt",
  "evidenceStatus",
  "sourcePointer",
  "confidence",
  "sensitivity",
  "allowedUses"
] as const;

export const CAREER_GOAL_DIFF_FIELDS = ["label", "horizon", "priority", "status"] as const;

export type CareerFactDiffField = (typeof CAREER_FACT_DIFF_FIELDS)[number];
export type CareerGoalDiffField = (typeof CAREER_GOAL_DIFF_FIELDS)[number];

export interface CareerTwinFactChange {
  factId: string;
  change: "added" | "removed" | "changed";
  changedFields: CareerFactDiffField[];
  beforeHash: string | null;
  afterHash: string | null;
  evidenceRefs: string[];
  assertion: IntelligenceAssertion;
}

export interface CareerTwinGoalChange {
  goalId: string;
  change: "added" | "removed" | "changed";
  changedFields: CareerGoalDiffField[];
  beforeHash: string | null;
  afterHash: string | null;
  assertion: IntelligenceAssertion;
}

export interface CareerTwinSnapshotDiff {
  twinId: string;
  fromVersion: number;
  toVersion: number;
  fromSnapshotHash: string;
  toSnapshotHash: string;
  factChanges: CareerTwinFactChange[];
  goalChanges: CareerTwinGoalChange[];
  assertions: IntelligenceAssertion[];
}

function contentHash(value: unknown): string {
  return sha256(stableStringify(value));
}

function factEvidence(fact: TemporalCareerFact | undefined): string[] {
  if (!fact) return [];
  return uniqueEvidenceRefs([[fact.sourcePointer], fact.claimId ? [`claim:${fact.claimId}`] : []]);
}

function changedFactFields(before: TemporalCareerFact, after: TemporalCareerFact): CareerFactDiffField[] {
  return CAREER_FACT_DIFF_FIELDS.filter((field) => stableStringify(before[field]) !== stableStringify(after[field]));
}

function changedGoalFields(before: CareerGoal, after: CareerGoal): CareerGoalDiffField[] {
  return CAREER_GOAL_DIFF_FIELDS.filter((field) => stableStringify(before[field]) !== stableStringify(after[field]));
}

export function diffCareerTwinRecords(previous: CareerTwin, current: CareerTwin): CareerTwinSnapshotDiff {
  const previousValidation = validateCareerTwin(previous);
  const currentValidation = validateCareerTwin(current);
  if (!previousValidation.valid) throw new Error(`Previous career twin is invalid: ${previousValidation.reasons.join(", ")}`);
  if (!currentValidation.valid) throw new Error(`Current career twin is invalid: ${currentValidation.reasons.join(", ")}`);
  if (previous.twinId !== current.twinId) throw new Error("Career twin snapshots must share the same twin id");
  if (current.twinVersion <= previous.twinVersion) throw new Error("Current career twin version must be newer");
  if (Date.parse(current.updatedAt) < Date.parse(previous.updatedAt)) throw new Error("Career twin snapshot time cannot move backwards");

  const previousFacts = new Map(previous.facts.map((fact) => [fact.factId, fact]));
  const currentFactsById = new Map(current.facts.map((fact) => [fact.factId, fact]));
  const factIds = [...new Set([...previousFacts.keys(), ...currentFactsById.keys()])].sort();
  const factChanges: CareerTwinFactChange[] = [];

  for (const factId of factIds) {
    const before = previousFacts.get(factId);
    const after = currentFactsById.get(factId);
    const evidenceRefs = uniqueEvidenceRefs([factEvidence(before), factEvidence(after)]);
    if (!before && after) {
      factChanges.push({
        factId,
        change: "added",
        changedFields: [...CAREER_FACT_DIFF_FIELDS],
        beforeHash: null,
        afterHash: contentHash(after),
        evidenceRefs,
        assertion: intelligenceAssertion("CAREER_TWIN_FACT_ADDED", evidenceRefs.length > 0 ? "evidence" : "policy", evidenceRefs)
      });
      continue;
    }
    if (before && !after) {
      factChanges.push({
        factId,
        change: "removed",
        changedFields: [...CAREER_FACT_DIFF_FIELDS],
        beforeHash: contentHash(before),
        afterHash: null,
        evidenceRefs,
        assertion: intelligenceAssertion("CAREER_TWIN_FACT_REMOVED", evidenceRefs.length > 0 ? "evidence" : "policy", evidenceRefs)
      });
      continue;
    }
    if (!before || !after) continue;
    const changedFields = changedFactFields(before, after);
    if (changedFields.length > 0) {
      factChanges.push({
        factId,
        change: "changed",
        changedFields,
        beforeHash: contentHash(before),
        afterHash: contentHash(after),
        evidenceRefs,
        assertion: intelligenceAssertion("CAREER_TWIN_FACT_CHANGED", evidenceRefs.length > 0 ? "evidence" : "policy", evidenceRefs)
      });
    }
  }

  const previousGoals = new Map(previous.goals.map((goal) => [goal.goalId, goal]));
  const currentGoals = new Map(current.goals.map((goal) => [goal.goalId, goal]));
  const goalIds = [...new Set([...previousGoals.keys(), ...currentGoals.keys()])].sort();
  const goalChanges: CareerTwinGoalChange[] = [];

  for (const goalId of goalIds) {
    const before = previousGoals.get(goalId);
    const after = currentGoals.get(goalId);
    if (!before && after) {
      goalChanges.push({
        goalId,
        change: "added",
        changedFields: [...CAREER_GOAL_DIFF_FIELDS],
        beforeHash: null,
        afterHash: contentHash(after),
        assertion: intelligenceAssertion("CAREER_TWIN_GOAL_ADDED", "policy")
      });
      continue;
    }
    if (before && !after) {
      goalChanges.push({
        goalId,
        change: "removed",
        changedFields: [...CAREER_GOAL_DIFF_FIELDS],
        beforeHash: contentHash(before),
        afterHash: null,
        assertion: intelligenceAssertion("CAREER_TWIN_GOAL_REMOVED", "policy")
      });
      continue;
    }
    if (!before || !after) continue;
    const changedFields = changedGoalFields(before, after);
    if (changedFields.length > 0) {
      goalChanges.push({
        goalId,
        change: "changed",
        changedFields,
        beforeHash: contentHash(before),
        afterHash: contentHash(after),
        assertion: intelligenceAssertion("CAREER_TWIN_GOAL_CHANGED", "policy")
      });
    }
  }

  return {
    twinId: current.twinId,
    fromVersion: previous.twinVersion,
    toVersion: current.twinVersion,
    fromSnapshotHash: previousValidation.snapshotHash,
    toSnapshotHash: currentValidation.snapshotHash,
    factChanges,
    goalChanges,
    assertions: [...factChanges.map((change) => change.assertion), ...goalChanges.map((change) => change.assertion)]
  };
}

export const COUNTERFACTUAL_HARD_GATES = [
  "eligibility-unresolved",
  "license-unverified",
  "work-authorization-unresolved",
  "financial-floor-unmet",
  "health-boundary-conflict",
  "family-boundary-conflict",
  "evidence-missing"
] as const;

export type CounterfactualHardGate = (typeof COUNTERFACTUAL_HARD_GATES)[number];

export interface CounterfactualAssumption {
  assumptionId: string;
  factId: string;
  state: "present" | "absent";
  evidenceRefs: string[];
}

export interface CounterfactualOptionalityRoute {
  routeId: string;
  requiredFactIds: string[];
  hardGates: CounterfactualHardGate[];
  evidenceRefs: string[];
}

export interface CounterfactualOptionalityInput {
  scenarioId: string;
  at: Date;
  assumptions: CounterfactualAssumption[];
  routes: CounterfactualOptionalityRoute[];
}

export interface CounterfactualRouteState {
  routeId: string;
  feasible: boolean;
  missingFactIds: string[];
  hardGates: CounterfactualHardGate[];
  evidenceRefs: string[];
}

export interface CounterfactualOptionalityResult {
  scenarioId: string;
  interpretation: "scenario-comparison-not-causal";
  baseline: CounterfactualRouteState[];
  counterfactual: CounterfactualRouteState[];
  openedRouteIds: string[];
  closedRouteIds: string[];
  modeledOptionalityDelta: number;
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

function routeState(route: CounterfactualOptionalityRoute, factIds: ReadonlySet<string>): CounterfactualRouteState {
  const missingFactIds = route.requiredFactIds.filter((factId) => !factIds.has(factId)).sort();
  return {
    routeId: route.routeId,
    feasible: missingFactIds.length === 0 && route.hardGates.length === 0,
    missingFactIds,
    hardGates: [...route.hardGates],
    evidenceRefs: [...route.evidenceRefs]
  };
}

export function evaluateCounterfactualOptionality(
  twin: CareerTwin,
  input: CounterfactualOptionalityInput
): CounterfactualOptionalityResult {
  const validation = validateCareerTwin(twin);
  if (!validation.valid) throw new Error(`Career twin is invalid: ${validation.reasons.join(", ")}`);
  if (!input.scenarioId.trim()) throw new Error("Counterfactual scenario id is required");
  if (!Number.isFinite(input.at.getTime())) throw new Error("Counterfactual evaluation time is invalid");

  const assumptionIds = new Set<string>();
  const assumedFactIds = new Set<string>();
  const assumptions = input.assumptions.map((assumption) => {
    if (assumptionIds.has(assumption.assumptionId)) throw new Error(`Duplicate assumption id: ${assumption.assumptionId}`);
    if (assumedFactIds.has(assumption.factId)) throw new Error(`Duplicate assumption fact id: ${assumption.factId}`);
    assumptionIds.add(assumption.assumptionId);
    assumedFactIds.add(assumption.factId);
    return {
      ...assumption,
      evidenceRefs: assertEvidenceRefs(assumption.evidenceRefs, `Counterfactual assumption ${assumption.assumptionId}`)
    };
  });

  const routeIds = new Set<string>();
  const routes = input.routes.map((route) => {
    if (routeIds.has(route.routeId)) throw new Error(`Duplicate counterfactual route id: ${route.routeId}`);
    routeIds.add(route.routeId);
    if (new Set(route.requiredFactIds).size !== route.requiredFactIds.length) {
      throw new Error(`Duplicate route requirement for ${route.routeId}`);
    }
    return {
      ...route,
      evidenceRefs: assertEvidenceRefs(route.evidenceRefs, `Counterfactual route ${route.routeId}`)
    };
  });

  const baselineFacts = new Set(currentFacts(twin, input.at).map((fact) => fact.factId));
  const counterfactualFacts = new Set(baselineFacts);
  for (const assumption of assumptions) {
    if (assumption.state === "present") counterfactualFacts.add(assumption.factId);
    else counterfactualFacts.delete(assumption.factId);
  }

  const baseline = routes.map((route) => routeState(route, baselineFacts));
  const counterfactual = routes.map((route) => routeState(route, counterfactualFacts));
  const baselineById = new Map(baseline.map((route) => [route.routeId, route]));
  const openedRouteIds = counterfactual
    .filter((route) => route.feasible && !baselineById.get(route.routeId)?.feasible)
    .map((route) => route.routeId)
    .sort();
  const closedRouteIds = counterfactual
    .filter((route) => !route.feasible && baselineById.get(route.routeId)?.feasible)
    .map((route) => route.routeId)
    .sort();
  const evidenceRefs = uniqueEvidenceRefs([
    ...assumptions.map((assumption) => assumption.evidenceRefs),
    ...routes.map((route) => route.evidenceRefs)
  ]);
  const routeEvidence = new Map(routes.map((route) => [route.routeId, route.evidenceRefs]));
  const assertions: IntelligenceAssertion[] = [intelligenceAssertion("COUNTERFACTUAL_SCENARIO_ONLY", "policy")];
  assertions.push(...openedRouteIds.map((routeId) => intelligenceAssertion("COUNTERFACTUAL_ROUTE_OPENED", "calculation", routeEvidence.get(routeId) ?? [])));
  assertions.push(...closedRouteIds.map((routeId) => intelligenceAssertion("COUNTERFACTUAL_ROUTE_CLOSED", "calculation", routeEvidence.get(routeId) ?? [])));
  if (openedRouteIds.length === 0 && closedRouteIds.length === 0) {
    assertions.push(intelligenceAssertion("COUNTERFACTUAL_NO_MODELED_CHANGE", "calculation", evidenceRefs));
  }
  if (routes.some((route) => route.hardGates.length > 0)) {
    assertions.push(intelligenceAssertion("COUNTERFACTUAL_ROUTE_HARD_GATED", "policy"));
  }

  return {
    scenarioId: input.scenarioId,
    interpretation: "scenario-comparison-not-causal",
    baseline,
    counterfactual,
    openedRouteIds,
    closedRouteIds,
    modeledOptionalityDelta: openedRouteIds.length - closedRouteIds.length,
    evidenceRefs,
    assertions
  };
}
