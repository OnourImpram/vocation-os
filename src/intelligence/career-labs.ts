import { sha256, stableStringify } from "../hash.js";

export interface EvidenceBoundStory {
  storyId: string;
  title: string;
  situationClaimIds: string[];
  taskClaimIds: string[];
  actionClaimIds: string[];
  resultClaimIds: string[];
  reflectionClaimIds: string[];
  permittedRoleFamilies: string[];
}

export interface InterviewPrompt {
  promptId: string;
  text: string;
  competency: string;
  sourcePointer: string;
}

export interface InterviewEvaluation {
  promptId: string;
  storyId: string;
  evidenceCoverage: number;
  structureCoverage: number;
  durationSeconds: number;
  fillerRate: number | null;
  unsupportedClaimIds: string[];
  status: "pass" | "review" | "blocked";
  evidencePointers: string[];
}

export interface AuthorizedContact {
  contactId: string;
  displayName: string;
  organization: string;
  relationship: "known" | "introduced" | "public-contact";
  source: "operator" | "authorized-export" | "official-directory";
  sourcePointer: string;
  lastContactAt: string | null;
  outreachCount90Days: number;
}

export interface NetworkPlan {
  contactId: string;
  status: "eligible" | "cooldown" | "blocked";
  reasons: string[];
  nextEligibleAt: string | null;
  evidencePointers: string[];
}

export interface OfferComponent {
  componentId: string;
  label: string;
  annualValue: number;
  currency: string;
  confidence: "High" | "Medium" | "Low";
  sourcePointer: string;
}

export interface OfferScenarioInput {
  offerId: string;
  components: OfferComponent[];
  conversionRates: Record<string, number>;
  targetCurrency: string;
  annualCostOfLiving: number;
  annualTaxEstimate: number | null;
  highStakesFlags: string[];
}

export interface OfferScenario {
  offerId: string;
  grossAnnualValue: number;
  disposableAnnualEstimate: number | null;
  confidence: "High" | "Medium" | "Low";
  specialistQuestions: CompatibilityOfferSpecialistQuestionCode[];
  evidencePointers: string[];
  scenarioHash: string;
}

export const COMPATIBILITY_OFFER_SPECIALIST_QUESTION_CODES = [
  "tax-specialist-verification-required",
  "work-authorization-specialist-verification-required",
  "licensing-specialist-verification-required",
  "legal-specialist-verification-required",
  "financial-specialist-verification-required",
  "high-stakes-specialist-verification-required"
] as const;

export type CompatibilityOfferSpecialistQuestionCode = (typeof COMPATIBILITY_OFFER_SPECIALIST_QUESTION_CODES)[number];

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function evaluateInterviewStory(input: {
  prompt: InterviewPrompt;
  story: EvidenceBoundStory;
  responseClaimIds: string[];
  durationSeconds: number;
  fillerCount?: number;
  wordCount?: number;
}): InterviewEvaluation {
  if (!input.prompt.sourcePointer.trim()) throw new Error("Interview prompt requires a source pointer");
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) throw new Error("Interview duration must be positive");
  const requiredGroups = [
    input.story.situationClaimIds,
    input.story.taskClaimIds,
    input.story.actionClaimIds,
    input.story.resultClaimIds,
    input.story.reflectionClaimIds
  ];
  if (requiredGroups.some((group) => group.length === 0)) throw new Error("Interview story requires evidence in every STAR+R group");
  const allowed = new Set(requiredGroups.flat());
  const response = unique(input.responseClaimIds);
  const unsupportedClaimIds = response.filter((claimId) => !allowed.has(claimId));
  const evidenceCoverage = Number((response.filter((claimId) => allowed.has(claimId)).length / allowed.size).toFixed(4));
  const structureCoverage = Number((requiredGroups.filter((group) => group.some((claimId) => response.includes(claimId))).length / requiredGroups.length).toFixed(4));
  const fillerRate = input.fillerCount === undefined || input.wordCount === undefined || input.wordCount === 0
    ? null
    : Number((input.fillerCount / input.wordCount).toFixed(4));
  const status = unsupportedClaimIds.length > 0 ? "blocked" : evidenceCoverage < 0.6 || structureCoverage < 0.8 ? "review" : "pass";
  const evidencePointers = unique([
    input.prompt.sourcePointer,
    ...requiredGroups.flat().map((claimId) => `claim:${claimId}`)
  ]);
  return {
    promptId: input.prompt.promptId,
    storyId: input.story.storyId,
    evidenceCoverage,
    structureCoverage,
    durationSeconds: input.durationSeconds,
    fillerRate,
    unsupportedClaimIds,
    status,
    evidencePointers
  };
}

export function planNetworkOutreach(
  contact: AuthorizedContact,
  now = new Date(),
  cooldownDays = 21,
  maxOutreach90Days = 3
): NetworkPlan {
  if (!contact.sourcePointer.trim()) throw new Error("Network contact requires an authorized source pointer");
  if (!Number.isSafeInteger(contact.outreachCount90Days) || contact.outreachCount90Days < 0) {
    throw new Error("Network outreach count is invalid");
  }
  const reasons: string[] = [];
  if (contact.relationship === "public-contact" && contact.source !== "official-directory") {
    reasons.push("network-public-contact-source-not-authoritative");
  }
  if (contact.outreachCount90Days >= maxOutreach90Days) reasons.push("network-fatigue-limit");
  let nextEligibleAt: string | null = null;
  if (contact.lastContactAt !== null) {
    const lastContactAt = Date.parse(contact.lastContactAt);
    if (!Number.isFinite(lastContactAt)) throw new Error("Network last contact timestamp is invalid");
    const eligibleAt = lastContactAt + cooldownDays * 86_400_000;
    if (now.getTime() < eligibleAt) {
      reasons.push("network-contact-cooldown");
      nextEligibleAt = new Date(eligibleAt).toISOString();
    }
  }
  const status = reasons.includes("network-public-contact-source-not-authoritative")
    ? "blocked"
    : reasons.length > 0
      ? "cooldown"
      : "eligible";
  return { contactId: contact.contactId, status, reasons: unique(reasons), nextEligibleAt, evidencePointers: [contact.sourcePointer] };
}

export function analyzeOfferScenario(input: OfferScenarioInput): OfferScenario {
  if (!input.targetCurrency.trim()) throw new Error("Offer target currency is required");
  if (!Number.isFinite(input.annualCostOfLiving) || input.annualCostOfLiving < 0) throw new Error("Offer cost of living is invalid");
  const evidencePointers = unique(input.components.map((component) => component.sourcePointer));
  if (evidencePointers.length !== input.components.length) throw new Error("Every offer component requires a distinct evidence pointer");
  let grossAnnualValue = 0;
  for (const component of input.components) {
    if (!Number.isFinite(component.annualValue) || component.annualValue < 0) throw new Error(`Offer component is invalid: ${component.componentId}`);
    const rate = component.currency === input.targetCurrency ? 1 : input.conversionRates[component.currency];
    if (!Number.isFinite(rate) || (rate ?? 0) <= 0) throw new Error(`Offer conversion rate is missing: ${component.currency}`);
    grossAnnualValue += component.annualValue * rate!;
  }
  grossAnnualValue = Number(grossAnnualValue.toFixed(2));
  const disposableAnnualEstimate = input.annualTaxEstimate === null
    ? null
    : Number((grossAnnualValue - input.annualTaxEstimate - input.annualCostOfLiving).toFixed(2));
  const specialistQuestions = [...new Set(input.highStakesFlags.map(specialistQuestionCode))].sort();
  const confidence: OfferScenario["confidence"] = input.highStakesFlags.length > 0
    || input.annualTaxEstimate === null
    || input.components.some((component) => component.confidence === "Low")
    ? "Low"
    : input.components.some((component) => component.confidence === "Medium")
      ? "Medium"
      : "High";
  const body = { offerId: input.offerId, grossAnnualValue, disposableAnnualEstimate, confidence, specialistQuestions, evidencePointers };
  return { ...body, scenarioHash: sha256(stableStringify(body)) };
}

function specialistQuestionCode(flag: string): CompatibilityOfferSpecialistQuestionCode {
  const normalizedFlag = flag.normalize("NFKC").trim().toLowerCase();
  if (normalizedFlag.includes("tax")) return "tax-specialist-verification-required";
  if (normalizedFlag.includes("work authorization") || normalizedFlag.includes("visa")) {
    return "work-authorization-specialist-verification-required";
  }
  if (normalizedFlag.includes("licens")) return "licensing-specialist-verification-required";
  if (normalizedFlag.includes("legal")) return "legal-specialist-verification-required";
  if (normalizedFlag.includes("financial")) return "financial-specialist-verification-required";
  return "high-stakes-specialist-verification-required";
}
