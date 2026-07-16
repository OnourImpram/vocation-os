export const INTELLIGENCE_ASSERTION_CODES = [
  "CAREER_TWIN_FACT_ADDED",
  "CAREER_TWIN_FACT_REMOVED",
  "CAREER_TWIN_FACT_CHANGED",
  "CAREER_TWIN_GOAL_ADDED",
  "CAREER_TWIN_GOAL_REMOVED",
  "CAREER_TWIN_GOAL_CHANGED",
  "COUNTERFACTUAL_SCENARIO_ONLY",
  "COUNTERFACTUAL_ROUTE_OPENED",
  "COUNTERFACTUAL_ROUTE_CLOSED",
  "COUNTERFACTUAL_NO_MODELED_CHANGE",
  "COUNTERFACTUAL_ROUTE_HARD_GATED",
  "PORTFOLIO_PARETO_EFFICIENT",
  "PORTFOLIO_DOMINATED",
  "PORTFOLIO_HARD_GATED",
  "PORTFOLIO_DIVERSITY_QUOTA_MET",
  "PORTFOLIO_DIVERSITY_QUOTA_UNMET",
  "CAMPAIGN_HARD_GATE_BLOCKED",
  "CAMPAIGN_QUALITY_THRESHOLD_MET",
  "CAMPAIGN_QUALITY_THRESHOLD_UNMET",
  "CAMPAIGN_REVIEW_QUEUED",
  "CAMPAIGN_REVIEW_CAP_REACHED",
  "CAMPAIGN_ROUTE_QUOTA_REACHED",
  "CAMPAIGN_NOT_MEMBER",
  "ATS_DOCUMENT_INVALID",
  "ATS_DOCUMENT_STRUCTURE_VALIDATED",
  "ATS_PARSEBACK_FAILED",
  "ATS_PARSEBACK_VALIDATED",
  "ATS_REQUIRED_TERM_MISSING",
  "ATS_REQUIRED_TERMS_COVERED",
  "ATS_REVIEW_REQUIRED",
  "INTERVIEW_STORY_VALID",
  "INTERVIEW_STORY_INVALID",
  "INTERVIEW_MOCK_EVIDENCE_GAP",
  "INTERVIEW_MOCK_STRUCTURE_COMPLETE",
  "INTERVIEW_MOCK_REVIEW_REQUIRED",
  "INTERVIEW_MOCK_CRITERIA_RECORDED",
  "NETWORK_CONTACT_NOT_SUPPLIED",
  "NETWORK_PERMISSION_BLOCKED",
  "NETWORK_CHANNEL_BLOCKED",
  "NETWORK_FATIGUE_LIMIT_REACHED",
  "NETWORK_SPACING_REQUIRED",
  "NETWORK_ACTION_REVIEW_REQUIRED",
  "NETWORK_ACTION_PLANNED",
  "OFFER_HARD_GATE_BLOCKED",
  "OFFER_SCENARIO_MODELED",
  "OFFER_SPECIALIST_REVIEW_REQUIRED",
  "OFFER_CURRENCY_MISMATCH",
  "OFFER_NOT_A_CERTAINTY",
  "EXPERIMENT_DESCRIPTIVE_ONLY",
  "EXPERIMENT_INSUFFICIENT_SAMPLE",
  "EXPERIMENT_CONTINUE",
  "EXPERIMENT_PAUSE_FOR_REVIEW",
  "EXPERIMENT_ROLLBACK_SAFETY",
  "EXPERIMENT_ROLLBACK_CALIBRATION",
  "EXPERIMENT_ROLLBACK_ADVERSE_RATE",
  "EXPERIMENT_MAX_SAMPLE_REACHED"
] as const;

export type IntelligenceAssertionCode = (typeof INTELLIGENCE_ASSERTION_CODES)[number];
export type IntelligenceAssertionBasis = "evidence" | "policy" | "calculation" | "operator-input";

export interface IntelligenceAssertion {
  code: IntelligenceAssertionCode;
  basis: IntelligenceAssertionBasis;
  evidenceRefs: string[];
}

export function uniqueEvidenceRefs(groups: ReadonlyArray<readonly string[]>): string[] {
  const refs = groups.flatMap((group) => group.map((value) => value.trim()).filter(Boolean));
  return [...new Set(refs)].sort();
}

export function assertEvidenceRefs(evidenceRefs: readonly string[], context: string): string[] {
  const normalized = uniqueEvidenceRefs([evidenceRefs]);
  if (normalized.length === 0) {
    throw new Error(`${context} requires at least one evidence reference`);
  }
  return normalized;
}

export function intelligenceAssertion(
  code: IntelligenceAssertionCode,
  basis: IntelligenceAssertionBasis,
  evidenceRefs: readonly string[] = []
): IntelligenceAssertion {
  const normalized = uniqueEvidenceRefs([evidenceRefs]);
  if ((basis === "evidence" || basis === "operator-input") && normalized.length === 0) {
    throw new Error(`${code} requires an evidence reference for ${basis} basis`);
  }
  return { code, basis, evidenceRefs: normalized };
}

export function assertFiniteRange(value: number, minimum: number, maximum: number, context: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${context} must be a finite number from ${minimum} to ${maximum}`);
  }
}

export function roundMetric(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
