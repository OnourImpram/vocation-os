import {
  assertEvidenceRefs,
  assertFiniteRange,
  intelligenceAssertion,
  roundMetric,
  uniqueEvidenceRefs,
  type IntelligenceAssertion
} from "./assertions.js";

export const OFFER_VALUE_KINDS = [
  "base-compensation",
  "variable-compensation",
  "equity",
  "benefit",
  "tax-cost",
  "relocation-cost",
  "recurring-cost",
  "one-time-cost"
] as const;

export const OFFER_DIMENSIONS = [
  "health-sustainability",
  "family-fit",
  "learning",
  "identity-congruence",
  "optionality",
  "reputation"
] as const;

export const OFFER_HARD_GATES = [
  "terms-unverified",
  "work-authorization-unresolved",
  "licensing-unresolved",
  "tax-treatment-unresolved",
  "relocation-unresolved",
  "payment-risk",
  "currency-unresolved"
] as const;

export const OFFER_SPECIALIST_QUESTION_CODES = [
  "equity-terms-review",
  "tax-review",
  "relocation-review",
  "work-authorization-review",
  "licensing-review",
  "currency-review"
] as const;

export type OfferValueKind = (typeof OFFER_VALUE_KINDS)[number];
export type OfferDimension = (typeof OFFER_DIMENSIONS)[number];
export type OfferHardGate = (typeof OFFER_HARD_GATES)[number];
export type OfferSpecialistQuestionCode = (typeof OFFER_SPECIALIST_QUESTION_CODES)[number];

export interface OfferValueItem {
  itemId: string;
  kind: OfferValueKind;
  effect: "income" | "cost";
  certainty: "guaranteed" | "contingent" | "estimated";
  annualRange: [number, number];
  currency: string;
  evidenceRefs: string[];
}

export interface OfferDimensionObservation {
  dimension: OfferDimension;
  score: number;
  evidenceRefs: string[];
}

export interface OfferAnalysisScenario {
  scenarioId: string;
  values: OfferValueItem[];
  dimensions: OfferDimensionObservation[];
  hardGates: OfferHardGate[];
}

export type OfferDimensionWeights = Record<OfferDimension, number>;

export interface OfferScenarioEvaluation {
  scenarioId: string;
  status: "hard-gated" | "scenario-only";
  currency: string | null;
  guaranteedAnnualRange: [number, number] | null;
  modeledAnnualRange: [number, number] | null;
  nonFinancialScore: number;
  paretoEfficient: boolean;
  hardGates: OfferHardGate[];
  specialistQuestionCodes: OfferSpecialistQuestionCode[];
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

interface PreparedOffer {
  scenario: OfferAnalysisScenario;
  status: OfferScenarioEvaluation["status"];
  currency: string | null;
  guaranteedAnnualRange: [number, number] | null;
  modeledAnnualRange: [number, number] | null;
  nonFinancialScore: number;
  specialistQuestionCodes: OfferSpecialistQuestionCode[];
  evidenceRefs: string[];
  currencyMismatch: boolean;
}

function normalizedWeights(weights: OfferDimensionWeights): OfferDimensionWeights {
  const values = OFFER_DIMENSIONS.map((dimension) => weights[dimension]);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Offer dimension weights must be finite and non-negative");
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error("At least one offer dimension weight must be positive");
  return Object.fromEntries(OFFER_DIMENSIONS.map((dimension) => [dimension, weights[dimension] / total])) as OfferDimensionWeights;
}

function addAnnualRange(items: OfferValueItem[]): [number, number] {
  let low = 0;
  let high = 0;
  for (const item of items) {
    if (item.effect === "income") {
      low += item.annualRange[0];
      high += item.annualRange[1];
    } else {
      low -= item.annualRange[1];
      high -= item.annualRange[0];
    }
  }
  return [roundMetric(low, 2), roundMetric(high, 2)];
}

function specialistQuestions(scenario: OfferAnalysisScenario, currencyMismatch: boolean): OfferSpecialistQuestionCode[] {
  const questions = new Set<OfferSpecialistQuestionCode>();
  if (scenario.values.some((item) => item.kind === "equity")) questions.add("equity-terms-review");
  if (scenario.values.some((item) => item.kind === "tax-cost") || scenario.hardGates.includes("tax-treatment-unresolved")) questions.add("tax-review");
  if (scenario.values.some((item) => item.kind === "relocation-cost") || scenario.hardGates.includes("relocation-unresolved")) questions.add("relocation-review");
  if (scenario.hardGates.includes("work-authorization-unresolved")) questions.add("work-authorization-review");
  if (scenario.hardGates.includes("licensing-unresolved")) questions.add("licensing-review");
  if (currencyMismatch || scenario.hardGates.includes("currency-unresolved")) questions.add("currency-review");
  return [...questions].sort();
}

function prepareOffer(scenario: OfferAnalysisScenario, weights: OfferDimensionWeights): PreparedOffer {
  if (!scenario.scenarioId.trim()) throw new Error("Offer scenario id is required");
  if (scenario.values.length === 0) throw new Error(`Offer scenario ${scenario.scenarioId} requires at least one value item`);
  const itemIds = scenario.values.map((item) => item.itemId);
  if (new Set(itemIds).size !== itemIds.length) throw new Error(`Offer value item ids must be unique for ${scenario.scenarioId}`);
  const valueEvidence: string[][] = [];
  for (const item of scenario.values) {
    if (!item.itemId.trim()) throw new Error("Offer value item id is required");
    if (!/^[A-Z]{3}$/u.test(item.currency)) throw new Error(`Offer currency for ${item.itemId} must be a three-letter uppercase code`);
    assertFiniteRange(item.annualRange[0], 0, Number.MAX_SAFE_INTEGER, `Offer range lower bound for ${item.itemId}`);
    assertFiniteRange(item.annualRange[1], 0, Number.MAX_SAFE_INTEGER, `Offer range upper bound for ${item.itemId}`);
    if (item.annualRange[0] > item.annualRange[1]) throw new Error(`Offer range is reversed for ${item.itemId}`);
    valueEvidence.push(assertEvidenceRefs(item.evidenceRefs, `Offer value ${item.itemId}`));
  }
  const dimensions = new Map<OfferDimension, OfferDimensionObservation>();
  const dimensionEvidence: string[][] = [];
  for (const observation of scenario.dimensions) {
    if (dimensions.has(observation.dimension)) throw new Error(`Duplicate offer dimension ${observation.dimension}`);
    assertFiniteRange(observation.score, 0, 100, `Offer dimension ${observation.dimension}`);
    const evidenceRefs = assertEvidenceRefs(observation.evidenceRefs, `Offer dimension ${observation.dimension}`);
    dimensions.set(observation.dimension, { ...observation, evidenceRefs });
    dimensionEvidence.push(evidenceRefs);
  }
  const missingDimensions = OFFER_DIMENSIONS.filter((dimension) => !dimensions.has(dimension));
  if (missingDimensions.length > 0) throw new Error(`Offer scenario is missing dimensions: ${missingDimensions.join(", ")}`);
  const currencies = [...new Set(scenario.values.map((item) => item.currency))];
  const currencyMismatch = currencies.length !== 1;
  const hardGates = [...new Set(scenario.hardGates)];
  const nonFinancialScore = OFFER_DIMENSIONS.reduce(
    (sum, dimension) => sum + (dimensions.get(dimension)?.score ?? 0) * weights[dimension],
    0
  );
  return {
    scenario: { ...scenario, hardGates },
    status: hardGates.length > 0 || currencyMismatch ? "hard-gated" : "scenario-only",
    currency: currencyMismatch ? null : currencies[0] ?? null,
    guaranteedAnnualRange: currencyMismatch ? null : addAnnualRange(scenario.values.filter((item) => item.certainty === "guaranteed")),
    modeledAnnualRange: currencyMismatch ? null : addAnnualRange(scenario.values),
    nonFinancialScore: roundMetric(nonFinancialScore, 2),
    specialistQuestionCodes: specialistQuestions(scenario, currencyMismatch),
    evidenceRefs: uniqueEvidenceRefs([...valueEvidence, ...dimensionEvidence]),
    currencyMismatch
  };
}

function dominates(left: PreparedOffer, right: PreparedOffer): boolean {
  if (left.status !== "scenario-only" || right.status !== "scenario-only") return false;
  const leftRange = left.modeledAnnualRange;
  const rightRange = right.modeledAnnualRange;
  if (!leftRange || !rightRange || left.currency !== right.currency) return false;
  const neverWorse = leftRange[0] >= rightRange[0] && left.nonFinancialScore >= right.nonFinancialScore;
  const sometimesBetter = leftRange[0] > rightRange[0] || left.nonFinancialScore > right.nonFinancialScore;
  return neverWorse && sometimesBetter;
}

export function analyzeOfferScenarios(
  scenarios: OfferAnalysisScenario[],
  weights: OfferDimensionWeights
): OfferScenarioEvaluation[] {
  const normalized = normalizedWeights(weights);
  const scenarioIds = scenarios.map((scenario) => scenario.scenarioId);
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error("Offer scenario ids must be unique");
  const prepared = scenarios.map((scenario) => prepareOffer(scenario, normalized));
  return prepared.map((entry) => {
    const paretoEfficient = entry.status === "scenario-only"
      && !prepared.some((other) => other.scenario.scenarioId !== entry.scenario.scenarioId && dominates(other, entry));
    const assertions: IntelligenceAssertion[] = [intelligenceAssertion("OFFER_NOT_A_CERTAINTY", "policy")];
    if (entry.status === "hard-gated") assertions.push(intelligenceAssertion("OFFER_HARD_GATE_BLOCKED", "policy"));
    else assertions.push(intelligenceAssertion("OFFER_SCENARIO_MODELED", "calculation", entry.evidenceRefs));
    if (entry.currencyMismatch) assertions.push(intelligenceAssertion("OFFER_CURRENCY_MISMATCH", "policy"));
    if (entry.specialistQuestionCodes.length > 0) assertions.push(intelligenceAssertion("OFFER_SPECIALIST_REVIEW_REQUIRED", "policy"));
    return {
      scenarioId: entry.scenario.scenarioId,
      status: entry.status,
      currency: entry.currency,
      guaranteedAnnualRange: entry.guaranteedAnnualRange,
      modeledAnnualRange: entry.modeledAnnualRange,
      nonFinancialScore: entry.nonFinancialScore,
      paretoEfficient,
      hardGates: entry.scenario.hardGates,
      specialistQuestionCodes: entry.specialistQuestionCodes,
      evidenceRefs: entry.evidenceRefs,
      assertions
    };
  });
}
