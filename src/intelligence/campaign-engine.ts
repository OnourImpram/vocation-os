import { sha256, stableStringify } from "../hash.js";

export const REVIEW_QUEUE_REASONS = [
  "duplicate-uncertain",
  "liveness-unresolved",
  "taxonomy-low-confidence",
  "truth-conflict",
  "campaign-quality-boundary",
  "human-review-required"
] as const;

export const CAMPAIGN_CANDIDATE_HARD_GATES = [
  "posting-not-live",
  "eligibility-unresolved",
  "licensing-sensitive",
  "license-unverified",
  "work-authorization-unresolved",
  "evidence-missing",
  "high-stakes-review-unresolved",
  "duplicate-opportunity",
  "already-submitted"
] as const;

export const CAMPAIGN_POLICY_BLOCK_CODES = [
  "campaign-company-excluded",
  "campaign-provider-excluded",
  "campaign-route-type-excluded",
  "campaign-fit-score-missing",
  "campaign-fit-score-below-threshold",
  "campaign-active-limit-exhausted",
  "campaign-daily-limit-exhausted",
  "campaign-company-limit-exhausted",
  "campaign-provider-limit-exhausted",
  "campaign-cooldown-active"
] as const;

export const CAMPAIGN_DECISION_BLOCK_CODES = [
  ...CAMPAIGN_CANDIDATE_HARD_GATES,
  ...CAMPAIGN_POLICY_BLOCK_CODES
] as const;

export type ReviewQueueReason = (typeof REVIEW_QUEUE_REASONS)[number];
export type CampaignCandidateHardGate = (typeof CAMPAIGN_CANDIDATE_HARD_GATES)[number];
export type CampaignDecisionBlockCode = (typeof CAMPAIGN_DECISION_BLOCK_CODES)[number];
export type ReviewQueueStatus = "pending" | "accepted" | "rejected" | "snoozed" | "resolved";

export interface CampaignPolicy {
  campaignId: string;
  profileId: string;
  minimumFitScore: number;
  maxActiveOpportunities: number;
  maxNewPerDay: number;
  maxPerCompany: number;
  maxPerProvider: number;
  cooldownHours: number;
  followUpAfterDays: number[];
  excludedCompanies: string[];
  excludedProviders: string[];
  allowedRouteTypes: string[];
  policyVersion: string;
}

export interface CampaignUsage {
  activeCount: number;
  addedToday: number;
  companyCounts: Record<string, number>;
  providerCounts: Record<string, number>;
  lastActionAt: string | null;
}

export interface CampaignCandidate {
  opportunityId: string;
  company: string;
  providerId: string;
  routeType: string;
  fitScore: number | null;
  hardGateFailures: CampaignCandidateHardGate[];
  reviewReasons: ReviewQueueReason[];
}

export interface CampaignDecision {
  opportunityId: string;
  status: "eligible" | "review" | "blocked";
  blockedBy: CampaignDecisionBlockCode[];
  reviewReasons: ReviewQueueReason[];
  policyVersion: string;
  evidencePointers: string[];
  decisionHash: string;
}

export interface ReviewQueueItem {
  queueItemId: string;
  opportunityId: string;
  campaignId: string;
  status: ReviewQueueStatus;
  reasons: ReviewQueueReason[];
  evidencePointers: string[];
  createdAt: string;
  snoozedUntil: string | null;
  resolution: "accept" | "reject" | "merge" | "keep-separate" | null;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

export function validateCampaignPolicy(policy: CampaignPolicy): void {
  if (!policy.campaignId.trim() || !policy.profileId.trim() || !policy.policyVersion.trim()) {
    throw new Error("Campaign identity and policy version are required");
  }
  if (!Number.isFinite(policy.minimumFitScore) || policy.minimumFitScore < 0 || policy.minimumFitScore > 100) {
    throw new Error("Campaign minimum fit score must be between 0 and 100");
  }
  assertNonNegativeInteger(policy.maxActiveOpportunities, "Campaign active limit");
  assertNonNegativeInteger(policy.maxNewPerDay, "Campaign daily limit");
  assertNonNegativeInteger(policy.maxPerCompany, "Campaign company limit");
  assertNonNegativeInteger(policy.maxPerProvider, "Campaign provider limit");
  assertNonNegativeInteger(policy.cooldownHours, "Campaign cooldown");
  if (policy.followUpAfterDays.some((day) => !Number.isSafeInteger(day) || day < 1)) {
    throw new Error("Campaign follow-up cadence must contain positive integer days");
  }
  if (new Set(policy.followUpAfterDays).size !== policy.followUpAfterDays.length) {
    throw new Error("Campaign follow-up cadence contains duplicates");
  }
}

export function evaluateCampaignCandidate(
  policy: CampaignPolicy,
  usage: CampaignUsage,
  candidate: CampaignCandidate,
  now = new Date()
): CampaignDecision {
  validateCampaignPolicy(policy);
  assertNonNegativeInteger(usage.activeCount, "Campaign active usage");
  assertNonNegativeInteger(usage.addedToday, "Campaign daily usage");
  const allowedHardGates = new Set<CampaignCandidateHardGate>(CAMPAIGN_CANDIDATE_HARD_GATES);
  if (candidate.hardGateFailures.some((reason) => !allowedHardGates.has(reason))) {
    throw new Error("Campaign candidate contains an unsupported hard gate code");
  }
  const blockedBy: CampaignDecisionBlockCode[] = [...new Set(candidate.hardGateFailures)];
  const company = normalized(candidate.company);
  const provider = normalized(candidate.providerId);
  if (policy.excludedCompanies.map(normalized).includes(company)) blockedBy.push("campaign-company-excluded");
  if (policy.excludedProviders.map(normalized).includes(provider)) blockedBy.push("campaign-provider-excluded");
  if (!policy.allowedRouteTypes.includes(candidate.routeType)) blockedBy.push("campaign-route-type-excluded");
  if (candidate.fitScore === null) blockedBy.push("campaign-fit-score-missing");
  else if (!Number.isFinite(candidate.fitScore) || candidate.fitScore < policy.minimumFitScore) blockedBy.push("campaign-fit-score-below-threshold");
  if (usage.activeCount >= policy.maxActiveOpportunities) blockedBy.push("campaign-active-limit-exhausted");
  if (usage.addedToday >= policy.maxNewPerDay) blockedBy.push("campaign-daily-limit-exhausted");
  if ((usage.companyCounts[company] ?? 0) >= policy.maxPerCompany) blockedBy.push("campaign-company-limit-exhausted");
  if ((usage.providerCounts[provider] ?? 0) >= policy.maxPerProvider) blockedBy.push("campaign-provider-limit-exhausted");
  if (usage.lastActionAt !== null) {
    const lastActionAt = Date.parse(usage.lastActionAt);
    if (!Number.isFinite(lastActionAt)) throw new Error("Campaign last action timestamp is invalid");
    if (now.getTime() - lastActionAt < policy.cooldownHours * 3_600_000) blockedBy.push("campaign-cooldown-active");
  }
  const uniqueBlockedBy = [...new Set(blockedBy)].sort() as CampaignDecisionBlockCode[];
  const reviewReasons = [...new Set(candidate.reviewReasons)].sort();
  const status: CampaignDecision["status"] = uniqueBlockedBy.length > 0
    ? "blocked"
    : reviewReasons.length > 0
      ? "review"
      : "eligible";
  const evidencePointers = [sha256(stableStringify({
    policy,
    usage,
    candidate,
    evaluatedAt: now.toISOString()
  }))];
  const body = {
    opportunityId: candidate.opportunityId,
    status,
    blockedBy: uniqueBlockedBy,
    reviewReasons,
    policyVersion: policy.policyVersion,
    evidencePointers
  };
  return { ...body, decisionHash: sha256(stableStringify(body)) };
}

export function createReviewQueueItem(input: {
  opportunityId: string;
  campaignId: string;
  reasons: ReviewQueueReason[];
  evidencePointers: string[];
  now?: Date;
}): ReviewQueueItem {
  if (input.reasons.length === 0) throw new Error("Review queue item requires at least one reason");
  const evidencePointers = [...new Set(input.evidencePointers.map((value) => value.trim()).filter(Boolean))].sort();
  if (evidencePointers.length === 0) throw new Error("Review queue item requires evidence pointers");
  const createdAt = (input.now ?? new Date()).toISOString();
  const digest = sha256(stableStringify({
    opportunityId: input.opportunityId,
    campaignId: input.campaignId,
    reasons: [...new Set(input.reasons)].sort(),
    evidencePointers,
    createdAt
  }));
  return {
    queueItemId: `RQ-${digest.slice("sha256:".length, "sha256:".length + 24).toUpperCase()}`,
    opportunityId: input.opportunityId,
    campaignId: input.campaignId,
    status: "pending",
    reasons: [...new Set(input.reasons)].sort(),
    evidencePointers,
    createdAt,
    snoozedUntil: null,
    resolution: null
  };
}

export function resolveReviewQueueItem(
  item: ReviewQueueItem,
  resolution: NonNullable<ReviewQueueItem["resolution"]>
): ReviewQueueItem {
  if (item.status !== "pending" && item.status !== "snoozed") throw new Error("Review queue item is already final");
  if (resolution === "accept" || resolution === "merge" || resolution === "keep-separate") {
    return { ...item, status: "resolved", resolution, snoozedUntil: null };
  }
  if (resolution === "reject") return { ...item, status: "rejected", resolution, snoozedUntil: null };
  throw new Error("Unsupported review queue resolution");
}

export function snoozeReviewQueueItem(item: ReviewQueueItem, snoozedUntil: string, now = new Date()): ReviewQueueItem {
  if (item.status !== "pending" && item.status !== "snoozed") throw new Error("Review queue item is already final");
  const timestamp = Date.parse(snoozedUntil);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    throw new Error("Snoozing requires a valid future timestamp");
  }
  return { ...item, status: "snoozed", resolution: null, snoozedUntil: new Date(timestamp).toISOString() };
}
