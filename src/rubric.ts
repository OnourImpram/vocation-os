import { createHash } from "node:crypto";
import { assertSchema } from "./schema.js";
import type { ApprovalReference, Confidence, EvidenceStatus, OpportunityScore, RubricDimension } from "./types.js";

export const DIMENSION_IDS = [
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
  "D06",
  "D07",
  "D08",
  "D09",
  "D10",
  "D11",
  "D12",
  "D13",
  "D14",
  "D15",
  "D16",
  "D17",
  "D18",
  "D19",
  "D20"
] as const;

const DEFAULT_LABELS = [
  "Strategic alignment",
  "Narrative fit",
  "Market signal",
  "Skill match",
  "Learning leverage",
  "Compensation feasibility",
  "Location feasibility",
  "Timing fit",
  "Network leverage",
  "Role clarity",
  "Autonomy fit",
  "Institutional credibility",
  "Growth path",
  "Portfolio value",
  "Reputation upside",
  "Energy sustainability",
  "Ethical risk",
  "Optionality preservation",
  "Evidence quality",
  "Execution practicality"
] as const;

export interface ScoreInput {
  dimensions: RubricDimension[];
  forced?: boolean;
  approvalReference?: ApprovalReference;
}

function getScore(dimensions: RubricDimension[], id: string): number | null {
  const dimension = dimensions.find((item) => item.id === id);
  if (!dimension) {
    throw new Error(`Missing dimension ${id}`);
  }
  return dimension.score;
}

function confidenceFromEvidence(dimensions: RubricDimension[], forced: boolean): Confidence {
  if (forced) {
    return "Low";
  }
  const verifiedCount = dimensions.filter((dimension) => dimension.evidenceStatus === "verified").length;
  const nullCount = dimensions.filter((dimension) => dimension.score === null).length;
  if (verifiedCount >= 17 && nullCount === 0) {
    return "High";
  }
  if (verifiedCount >= 10 && nullCount <= 3) {
    return "Medium";
  }
  return "Low";
}

function uncertaintyWidth(confidence: Confidence, forced: boolean): number {
  if (forced) {
    return 36;
  }
  if (confidence === "High") {
    return 10;
  }
  if (confidence === "Medium") {
    return 20;
  }
  return 34;
}

function makeBand(score: number | null, confidence: Confidence, forced: boolean): [number, number] | null {
  if (score === null) {
    return null;
  }
  const width = uncertaintyWidth(confidence, forced);
  const low = Math.max(0, Math.round(score - width / 2));
  const high = Math.min(100, Math.round(score + width / 2));
  return [low, high];
}

function redactApprovalReference(reference: ApprovalReference): string {
  const digest = createHash("sha256")
    .update(`${reference.approvalId}:${reference.approvedAt}:${reference.approvalTextHash}`)
    .digest("hex")
    .slice(0, 12);
  return `approval:sha256:${digest}`;
}

function validateDimensions(dimensions: RubricDimension[], forced: boolean): void {
  if (dimensions.length !== DIMENSION_IDS.length) {
    throw new Error(`Expected ${DIMENSION_IDS.length} rubric dimensions`);
  }

  const seen = new Set<string>();
  for (const dimension of dimensions) {
    if (seen.has(dimension.id)) {
      throw new Error(`Duplicate rubric dimension id: ${dimension.id}`);
    }
    seen.add(dimension.id);

    if (!DIMENSION_IDS.includes(dimension.id as (typeof DIMENSION_IDS)[number])) {
      throw new Error(`Unknown rubric dimension id: ${dimension.id}`);
    }

    if (dimension.score !== null) {
      if (!Number.isInteger(dimension.score) || dimension.score < 0 || dimension.score > 100) {
        throw new Error(`Invalid score for ${dimension.id}`);
      }
    }

    const weakEvidence: EvidenceStatus[] = ["unverified", "current_source_required"];
    if (!forced && weakEvidence.includes(dimension.evidenceStatus) && dimension.score !== null) {
      throw new Error(`Weak evidence cannot carry a precise score for ${dimension.id}`);
    }
  }

  for (const id of DIMENSION_IDS) {
    if (!seen.has(id)) {
      throw new Error(`Missing rubric dimension id: ${id}`);
    }
  }
}

function computeComposite(dimensions: RubricDimension[]): { score: number | null; capReasons: string[] } {
  const scored = dimensions.filter((dimension): dimension is RubricDimension & { score: number } => dimension.score !== null);
  if (scored.length === 0) {
    return { score: null, capReasons: [] };
  }

  let score = Math.round(scored.reduce((sum, dimension) => sum + dimension.score, 0) / scored.length);
  const capReasons: string[] = [];
  const strategic = getScore(dimensions, "D01");
  const narrative = getScore(dimensions, "D02");
  const ethical = getScore(dimensions, "D17");

  if (strategic !== null && strategic < 40) {
    score = Math.min(score, 49);
    capReasons.push("D01 strategic alignment below 40 caps composite at 49");
  }
  if (narrative !== null && narrative < 40) {
    score = Math.min(score, 49);
    capReasons.push("D02 narrative fit below 40 caps composite at 49");
  }
  if (ethical !== null && ethical < 40) {
    score = Math.min(score, 39);
    capReasons.push("D17 ethical risk below 40 caps composite at 39");
  }

  return { score, capReasons };
}

function uncertaintyDrivers(dimensions: RubricDimension[], forced: boolean): string[] {
  const drivers: string[] = [];
  if (forced) {
    drivers.push("forced score requires operator review");
  }
  for (const dimension of dimensions) {
    if (dimension.score === null) {
      drivers.push(`${dimension.id} ${dimension.label} missing score`);
    }
    if (dimension.evidenceStatus !== "verified") {
      drivers.push(`${dimension.id} ${dimension.label} evidence is ${dimension.evidenceStatus}`);
    }
  }
  return drivers.slice(0, 8);
}

export function scoreOpportunity(input: ScoreInput): OpportunityScore {
  const forced = input.forced === true;
  if (forced && !input.approvalReference) {
    throw new Error("Forced score requires operator approval reference");
  }

  validateDimensions(input.dimensions, forced);
  const { score, capReasons } = computeComposite(input.dimensions);
  const confidence = confidenceFromEvidence(input.dimensions, forced);
  const result: OpportunityScore = {
    compositeScore: score,
    confidence,
    dimensions: input.dimensions,
    uncertaintyBand: makeBand(score, confidence, forced),
    uncertaintyDrivers: uncertaintyDrivers(input.dimensions, forced),
    capReasons,
    forced
  };

  if (forced && input.approvalReference) {
    result.auditReference = redactApprovalReference(input.approvalReference);
  }

  assertSchema("opportunity-score", result);
  return result;
}

export function demoDimensions(score = 72): RubricDimension[] {
  return DIMENSION_IDS.map((id, index) => ({
    id,
    label: DEFAULT_LABELS[index] ?? id,
    score,
    evidenceStatus: "verified"
  }));
}
