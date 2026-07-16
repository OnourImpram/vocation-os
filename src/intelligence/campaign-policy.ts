import type { CareerOption } from "../portfolio.js";
import type { CampaignRecord } from "../storage/product-repositories.js";
import type { Confidence } from "../types.js";
import {
  assertEvidenceRefs,
  assertFiniteRange,
  intelligenceAssertion,
  type IntelligenceAssertion,
  type IntelligenceAssertionCode
} from "./assertions.js";

export const CAMPAIGN_HARD_GATES = [
  "posting-not-live",
  "eligibility-unresolved",
  "license-unverified",
  "work-authorization-unresolved",
  "evidence-missing",
  "high-stakes-review-unresolved",
  "duplicate-opportunity",
  "already-submitted"
] as const;

export type CampaignHardGate = (typeof CAMPAIGN_HARD_GATES)[number];
export type CampaignRouteType = CareerOption["routeType"];

export interface CampaignReviewCandidate {
  opportunityId: string;
  routeType: CampaignRouteType;
  qualityScore: number | null;
  confidence: Confidence;
  hardGates: CampaignHardGate[];
  evidenceRefs: string[];
}

export interface CampaignReviewPolicy {
  policyVersion: string;
  minimumQualityScore: number;
  dailyReviewLimit: number;
  routeReviewQuotas: Partial<Record<CampaignRouteType, number>>;
}

export interface CampaignReviewDisposition {
  opportunityId: string;
  status: "queued" | "hard-gated" | "below-threshold" | "deferred" | "not-member";
  reasonCode: IntelligenceAssertionCode;
  queuePosition: number | null;
  reviewRequired: boolean;
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

export interface CampaignReviewQueue {
  campaignId: string;
  policyVersion: string;
  generatedAt: string;
  entries: CampaignReviewDisposition[];
  dispositions: CampaignReviewDisposition[];
  assertions: IntelligenceAssertion[];
}

const CONFIDENCE_RANK: Record<Confidence, number> = { High: 3, Medium: 2, Low: 1 };

function validateCampaignPolicy(policy: CampaignReviewPolicy): void {
  if (!policy.policyVersion.trim()) throw new Error("Campaign policy version is required");
  assertFiniteRange(policy.minimumQualityScore, 0, 100, "Campaign minimum quality score");
  if (!Number.isInteger(policy.dailyReviewLimit) || policy.dailyReviewLimit < 1) {
    throw new Error("Campaign daily review limit must be a positive integer");
  }
  for (const [routeType, quota] of Object.entries(policy.routeReviewQuotas)) {
    if (!Number.isInteger(quota) || quota < 1) throw new Error(`Campaign route quota for ${routeType} must be a positive integer`);
  }
}

function disposition(
  candidate: CampaignReviewCandidate,
  status: CampaignReviewDisposition["status"],
  reasonCode: IntelligenceAssertionCode,
  queuePosition: number | null,
  reviewRequired: boolean,
  basis: "evidence" | "policy" | "calculation"
): CampaignReviewDisposition {
  return {
    opportunityId: candidate.opportunityId,
    status,
    reasonCode,
    queuePosition,
    reviewRequired,
    evidenceRefs: candidate.evidenceRefs,
    assertions: [intelligenceAssertion(reasonCode, basis, basis === "policy" ? [] : candidate.evidenceRefs)]
  };
}

export function buildCampaignReviewQueue(
  campaign: Pick<CampaignRecord, "campaignId" | "opportunityIds">,
  candidates: CampaignReviewCandidate[],
  policy: CampaignReviewPolicy,
  now = new Date()
): CampaignReviewQueue {
  validateCampaignPolicy(policy);
  if (!Number.isFinite(now.getTime())) throw new Error("Campaign queue generation time is invalid");
  const candidateIds = candidates.map((candidate) => candidate.opportunityId);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error("Campaign candidates must have unique opportunity ids");
  const campaignOpportunityIds = new Set(campaign.opportunityIds);
  const normalized = candidates.map((candidate) => {
    if (!candidate.opportunityId.trim()) throw new Error("Campaign candidate opportunity id is required");
    if (candidate.qualityScore !== null) assertFiniteRange(candidate.qualityScore, 0, 100, `Campaign quality score for ${candidate.opportunityId}`);
    return {
      ...candidate,
      hardGates: [...new Set(candidate.hardGates)],
      evidenceRefs: assertEvidenceRefs(candidate.evidenceRefs, `Campaign candidate ${candidate.opportunityId}`)
    };
  });

  const dispositions: CampaignReviewDisposition[] = [];
  const eligible: CampaignReviewCandidate[] = [];
  for (const candidate of normalized) {
    if (!campaignOpportunityIds.has(candidate.opportunityId)) {
      dispositions.push(disposition(candidate, "not-member", "CAMPAIGN_NOT_MEMBER", null, false, "policy"));
    } else if (candidate.hardGates.length > 0) {
      dispositions.push(disposition(candidate, "hard-gated", "CAMPAIGN_HARD_GATE_BLOCKED", null, false, "policy"));
    } else if (candidate.qualityScore === null || candidate.qualityScore < policy.minimumQualityScore) {
      dispositions.push(disposition(candidate, "below-threshold", "CAMPAIGN_QUALITY_THRESHOLD_UNMET", null, false, "calculation"));
    } else {
      eligible.push(candidate);
    }
  }

  eligible.sort((left, right) =>
    (right.qualityScore ?? -1) - (left.qualityScore ?? -1)
    || CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence]
    || left.opportunityId.localeCompare(right.opportunityId)
  );
  const routeCounts = new Map<CampaignRouteType, number>();
  let queuedCount = 0;
  for (const candidate of eligible) {
    if (queuedCount >= policy.dailyReviewLimit) {
      dispositions.push(disposition(candidate, "deferred", "CAMPAIGN_REVIEW_CAP_REACHED", null, false, "policy"));
      continue;
    }
    const routeCount = routeCounts.get(candidate.routeType) ?? 0;
    const routeQuota = policy.routeReviewQuotas[candidate.routeType];
    if (routeQuota !== undefined && routeCount >= routeQuota) {
      dispositions.push(disposition(candidate, "deferred", "CAMPAIGN_ROUTE_QUOTA_REACHED", null, false, "policy"));
      continue;
    }
    queuedCount += 1;
    routeCounts.set(candidate.routeType, routeCount + 1);
    dispositions.push(disposition(candidate, "queued", "CAMPAIGN_REVIEW_QUEUED", queuedCount, true, "calculation"));
  }

  dispositions.sort((left, right) => {
    if (left.queuePosition !== null && right.queuePosition !== null) return left.queuePosition - right.queuePosition;
    if (left.queuePosition !== null) return -1;
    if (right.queuePosition !== null) return 1;
    return left.opportunityId.localeCompare(right.opportunityId);
  });
  const entries = dispositions.filter((entry) => entry.status === "queued");
  return {
    campaignId: campaign.campaignId,
    policyVersion: policy.policyVersion,
    generatedAt: now.toISOString(),
    entries,
    dispositions,
    assertions: dispositions.flatMap((entry) => entry.assertions)
  };
}
