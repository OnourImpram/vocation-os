export const PRODUCT_NAME = "VocationOS";
export const TAGLINE = "Evidence grounded career decision safety for high agency operators.";

export const MODE_NAMES = [
  "/decision-intake",
  "/profile-audit",
  "/opportunity-ingest",
  "/deep-fit",
  "/route-map",
  "/cv-tailor",
  "/cover-letter",
  "/outreach",
  "/interview-brief",
  "/negotiation",
  "/fellowship-watch",
  "/phd-strategy",
  "/founder-route",
  "/public-profile",
  "/evidence-gap",
  "/steelman",
  "/risk-register",
  "/application-packet",
  "/auto-apply-config",
  "/post-action-review",
  "/skill-coach"
] as const;

export const CLI_COMMANDS = [
  "help",
  "doctor",
  "metrics",
  "validate-state",
  "validate-schemas",
  "selfcheck",
  "evaluate",
  "demo-score",
  "demo-steelman",
  "demo-auto-apply-decision",
  "demo-auto-apply-allowed",
  "export-audit",
  "auto-apply-status",
  "auto-apply-kill",
  "auto-apply-rearm",
  "auto-apply-enable",
  "auto-apply-evaluate",
  "list-modes",
  "list-theories",
  "list-dimensions",
  "privacy-guidance",
  "governance-scope",
  "demo-career-twin",
  "demo-portfolio",
  "demo-opportunity-intake",
  "demo-skill-coach",
  "demo-advisory",
  "benchmark",
  "discover",
  "taxonomy",
  "assurance",
  "credential",
  "agents",
  "models",
  "tui",
  "workbench",
  "list-workers",
  "daemon-status",
  "daemon-stop",
  "legacy-import-plan",
  "legacy-import-apply",
  "checkpoint-create",
  "checkpoint-verify",
  "approver-list",
  "approver-register",
  "approver-revoke",
  "collector-list",
  "collector-register",
  "collector-revoke",
  "store-backup",
  "store-restore",
  "store-rollback",
  "store-verify",
  "store-doctor",
  "init",
  "artifact-import",
  "artifact-list",
  "domain-put",
  "domain-get",
  "domain-list",
  "domain-archive",
  "onboarding-status",
  "profile-import-plan",
  "profile-import-plan-show",
  "profile-import-apply",
  "document-render",
  "tracker-list",
  "tracker-get",
  "tracker-create",
  "tracker-approve",
  "tracker-submit",
  "tracker-block",
  "tracker-confirm"
] as const;

export type ModeName = (typeof MODE_NAMES)[number];
export type CliCommand = (typeof CLI_COMMANDS)[number];

export type EvidenceStatus =
  | "verified"
  | "operator_supplied"
  | "inferred"
  | "unverified"
  | "current_source_required";

export type SourceSearchOutcome =
  | "found-current-source"
  | "no-current-source-found"
  | "conflicting-sources"
  | "search-not-run"
  | "search-failed";

export const RECENCY_POLICY_IDS = [
  "job-liveness",
  "salary-market",
  "legal-regulatory",
  "organization-contact",
  "credential-status"
] as const;

export type RecencyPolicyId = (typeof RECENCY_POLICY_IDS)[number];

export type ReversibilityTag = "R0" | "R1" | "R2" | "R3" | "R4";
export type Confidence = "High" | "Medium" | "Low";

export const HIGH_STAKES_FLAGS = [
  "immigrationSensitive",
  "licensingSensitive",
  "financialLiabilitySensitive",
  "clinicalOrMentalHealthSensitive",
  "researchIntegritySensitive",
  "conflictOfInterestSensitive",
  "publicReputationSensitive",
  "familyRelocationSensitive"
] as const;

export type HighStakesFlag = (typeof HIGH_STAKES_FLAGS)[number];
export type HighStakesFlags = Partial<Record<HighStakesFlag, boolean>>;

export interface Claim {
  claimId: string;
  text: string;
  canonicalTextHash: string;
  claimType:
    | "degree"
    | "license"
    | "publication"
    | "affiliation"
    | "grant"
    | "employment"
    | "credential"
    | "award"
    | "skill"
    | "project"
    | "other";
  evidenceStatus: EvidenceStatus;
  sourceType: "file" | "url" | "official-record" | "self-attested" | "operator-supplied";
  sourcePointer: string;
  verifiedDate?: string;
  recencyRequired: boolean;
  recencyPolicyId?: RecencyPolicyId;
  publiclyAssertable: boolean;
  allowedInCv: boolean;
  allowedInOutreach: boolean;
  allowedInAutoApply: boolean;
}

export interface ClaimGraph {
  profileId: string;
  profileScope: "synthetic" | "local-private";
  generatedAt: string;
  graphVersion: string;
  claims: Claim[];
  validationSummary: {
    verifiedClaims: number;
    unverifiedClaims: number;
    privateClaims: number;
  };
}

export interface ApplicationPacketClaim {
  claimId: string;
  text: string;
  sourceClaimTextHash: string;
  evidenceStatus: EvidenceStatus;
  sourcePointer: string;
  publiclyAssertable: boolean;
}

export interface ApplicationPacket {
  opportunityId: string;
  claims: ApplicationPacketClaim[];
  documents: Array<{
    kind: "cv" | "cover-letter" | "outreach" | "other";
    path: string;
    contentHash: string;
  }>;
  tosCompliant: boolean;
  generatedAt: string;
  packetHash: string;
  approvalRequired: boolean;
}

export interface KillSwitchState {
  available: boolean;
  engaged: boolean;
  engagedAt?: string;
  engagedBy?: string;
  reason?: string;
}

export interface AutoApplyConfig {
  enabled: boolean;
  mode: "manual" | "draft-only" | "auto";
  killSwitch: KillSwitchState;
  rateLimit: {
    maxPerDay: number;
    cooldownUntil?: string;
  };
  adapterAllowlist: string[];
  perOpportunity: Record<string, { mode?: "manual" | "draft-only" | "auto"; excluded?: boolean }>;
  exclusionRules: string[];
}

export interface ApprovalReference {
  approvalId: string;
  operation: "auto-apply" | "forced-score";
  approvedBy: string;
  keyId: string;
  approvedAt: string;
  expiresAt: string;
  approvalTextHash: string;
  opportunityId: string;
  packetHash: string;
  adapterId: string;
  actionIntentHash: string;
  allowedFields: string[];
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface AutomationRiskSignals {
  captchaPresent: boolean;
  antiBotDetected: boolean;
  paymentRequired: boolean;
  identityCheckRequired: boolean;
  tosUnclear: boolean;
  unsupportedLicenseClaim: boolean;
  credentialFabricationRequested: boolean;
}

export interface AutoApplyDecision {
  allowed: boolean;
  blockedBy?: string;
  reasons: string[];
  requiredApprovals: string[];
  ledgerActionId?: string;
  confirmationEvidenceRequired: boolean;
  auditError?: string;
}

export interface ActionLedgerEntry {
  actionId: string;
  timestamp: string;
  mode: string;
  opportunityId: string;
  reversibilityTag: ReversibilityTag;
  evidenceGatePassed: boolean;
  approvalRequired: boolean;
  approvalReceived: boolean;
  highStakesGatePassed: boolean;
  result: "blocked" | "decision_allowed" | "draft_generated" | "submitted" | "confirmed";
  blockedBy?: string;
  confirmationEvidencePointer?: string;
}

export interface RubricDimension {
  id: string;
  label: string;
  score: number | null;
  evidenceStatus: EvidenceStatus;
}

export interface OpportunityScore {
  compositeScore: number | null;
  confidence: Confidence;
  dimensions: RubricDimension[];
  uncertaintyBand: [number, number] | null;
  uncertaintyDrivers: string[];
  capReasons: string[];
  forced: boolean;
  auditReference?: string;
}

export interface ModeOutput {
  mode: ModeName;
  reversibilityTag: ReversibilityTag;
  humanApprovalRequired: boolean;
  highStakesCertaintyGate: boolean;
  verificationPerformed: string[];
  specialistQuestions: string[];
}
