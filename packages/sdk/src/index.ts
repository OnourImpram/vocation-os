export const AUTHORITY_OPERATIONS = [
  "health",
  "daemon-stop",
  "auto-apply-status",
  "auto-apply-kill",
  "auto-apply-rearm",
  "auto-apply-enable",
  "auto-apply-evaluate",
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
  "audit-export",
  "network-grant-register",
  "network-grant-list",
  "discovery-run",
  "discovery-review-list",
  "source-observation-record",
  "source-observation-get",
  "source-observation-list",
  "opportunity-truth-record",
  "opportunity-truth-get",
  "opportunity-truth-list",
  "liveness-assessment-record",
  "liveness-assessment-get",
  "liveness-assessment-list",
  "dedupe-result-record",
  "dedupe-result-get",
  "dedupe-result-list",
  "taxonomy-snapshot-record",
  "taxonomy-snapshot-import-artifact",
  "taxonomy-snapshot-get",
  "taxonomy-snapshot-list",
  "taxonomy-query",
  "taxonomy-mapping-record",
  "taxonomy-mapping-get",
  "taxonomy-mapping-list",
  "assurance-case-record",
  "assurance-case-get",
  "assurance-case-list",
  "credential-passport-record",
  "credential-import-artifact",
  "credential-export-artifact",
  "credential-passport-get",
  "credential-passport-list",
  "credential-mapping-record",
  "credential-mapping-get",
  "credential-mapping-list",
  "campaign-record",
  "campaign-get",
  "campaign-list",
  "campaign-archive",
  "outcome-record",
  "outcome-get",
  "outcome-list",
  "outcome-archive",
  "domain-get",
  "domain-list",
  "domain-put",
  "domain-archive",
  "artifact-list",
  "artifact-import",
  "artifact-export",
  "onboarding-status",
  "onboarding-start",
  "onboarding-complete-step",
  "onboarding-fail",
  "onboarding-cancel",
  "onboarding-resume",
  "profile-import-plan",
  "profile-import-plan-get",
  "profile-import-apply",
  "tracker-list",
  "tracker-get",
  "tracker-create",
  "tracker-approve",
  "tracker-submit",
  "tracker-block",
  "tracker-confirm"
] as const;

export type AuthorityOperation = (typeof AUTHORITY_OPERATIONS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type EmptyAuthorityPayload = Readonly<Record<string, never>>;

export type ProductDomainName =
  | "profiles"
  | "opportunities"
  | "documents"
  | "campaigns"
  | "applications"
  | "tasks"
  | "outcomes"
  | "answers";

export type DecisionIntelligenceDomain =
  | "source-observations"
  | "opportunity-truth-records"
  | "liveness-assessments"
  | "dedupe-results"
  | "taxonomy-snapshots"
  | "taxonomy-mapping-sets"
  | "career-assurance-cases"
  | "credential-passport-records"
  | "credential-mapping-plans";

export interface AuthorityRecordBinding {
  readonly requestId: string;
  readonly requestHash: string;
  readonly operation: AuthorityOperation;
}

export interface VersionedRecordSummary<TDomain extends string = string> {
  readonly domain: TDomain;
  readonly recordId: string;
  readonly version: number;
  readonly valueHash: string;
  readonly recordedAt: string;
}

export interface AuthorityRecordSummary<TDomain extends string = string>
  extends VersionedRecordSummary<TDomain> {
  readonly authority: AuthorityRecordBinding;
}

export interface PagedSummaries<TItem = AuthorityRecordSummary> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly pageHash: string;
}

export type PagedAuthorityRecordSummaries<TDomain extends string = string> =
  PagedSummaries<AuthorityRecordSummary<TDomain>>;

export interface VersionedRecord<
  TValue = JsonValue,
  TDomain extends string = string
> {
  readonly domain: TDomain;
  readonly recordId: string;
  readonly version: number;
  readonly value: TValue;
  readonly valueHash: string;
  readonly recordedAt: string;
}

export interface VersionedAuthorityRecord<
  TValue = JsonValue,
  TDomain extends string = DecisionIntelligenceDomain
> extends VersionedRecord<TValue, TDomain> {
  readonly authority: AuthorityRecordBinding;
}

export interface VersionedDomainRecord<
  TValue = JsonValue,
  TDomain extends ProductDomainName = ProductDomainName
> extends VersionedRecord<TValue, TDomain> {
  readonly status: "active" | "archived";
  readonly operationId: string;
}

export type GenericVersionedRecord<
  TValue = JsonValue,
  TDomain extends string = string
> = VersionedRecord<TValue, TDomain>;

export interface ArtifactManifest {
  readonly format: "vocation-os-artifact";
  readonly version: 1;
  readonly cipher: "aes-256-gcm";
  readonly contentHash: string;
  readonly storageLocator: string;
  readonly sizeBytes: number;
}

export type DiscoveryProviderId =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "workday"
  | "smartrecruiters"
  | "teamtailor"
  | "bamboohr"
  | "breezy-hr"
  | "recruitee"
  | "personio"
  | "schema-org-job-posting"
  | "comeet"
  | "pinpoint"
  | "jazzhr"
  | "rippling"
  | "zoho-recruit"
  | "freshteam"
  | "recruit-crm"
  | "oracle-recruiting"
  | "sap-successfactors"
  | "taleo"
  | "adp-workforce-now"
  | "ukg-pro"
  | "dayforce"
  | "usajobs"
  | "eures"
  | "euraxess"
  | "nhs-jobs"
  | "remote-ok"
  | "remotive"
  | "we-work-remotely"
  | "arbeitnow"
  | "jobicy"
  | "jobvite"
  | "icims";

export interface NetworkAccessGrant {
  readonly grantId: string;
  readonly subject: string;
  readonly purpose: string;
  readonly providerId: DiscoveryProviderId;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly allowedHosts: readonly string[];
  readonly allowedMethods: readonly ("GET" | "HEAD")[];
  readonly requestBudget: number;
}

export interface SignedNetworkAccessGrantEnvelope {
  readonly grant: NetworkAccessGrant;
  readonly approvedBy: string;
  readonly keyId: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly grantDigest: string;
  readonly signature: string;
}

export interface NetworkAccessGrantSummary {
  readonly grantId: string;
  readonly grantDigest: string;
  readonly providerId: DiscoveryProviderId;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly approvedBy: string;
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly requestBudget: number;
  readonly registeredAt: string;
}

export interface NetworkGrantRegisterPayload {
  readonly envelope: SignedNetworkAccessGrantEnvelope;
  readonly scopeUrl: string | null;
}

export interface DiscoveryRunPayload {
  readonly providerId: DiscoveryProviderId;
  readonly grantId: string;
  readonly sourceKey: string;
  readonly url: string;
  readonly companyHint: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly operatorScopedTarget: boolean;
}

export interface DiscoveryPostingSummary {
  readonly opportunity: VersionedRecordSummary<"opportunities">;
  readonly observation: VersionedRecordSummary<"source-observations">;
  readonly liveness: VersionedRecordSummary<"liveness-assessments">;
  readonly truth: VersionedRecordSummary<"opportunity-truth-records">;
}

export interface DiscoveryRunResponse {
  readonly providerId: DiscoveryProviderId;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly endpointObservation: VersionedRecordSummary<"source-observations">;
  readonly endpointLiveness: VersionedRecordSummary<"liveness-assessments">;
  readonly postings: readonly DiscoveryPostingSummary[];
  readonly dedupe: VersionedRecordSummary<"dedupe-results"> | null;
  readonly rejectionCount: number;
  readonly runHash: string;
}

export type DiscoveryReviewStatus = "ready" | "needs_review" | "blocked";
export type DiscoveryDuplicateStatus = "merge" | "review" | "distinct" | "unassessed";

export interface DiscoveryReviewItem {
  readonly opportunityId: string;
  readonly version: number;
  readonly roleTitle: string;
  readonly company: string;
  readonly locationText: string;
  readonly providerId: DiscoveryProviderId;
  readonly sourceKey: string;
  readonly status: DiscoveryReviewStatus;
  readonly liveness: "live" | "closed" | "stale" | "unreachable" | "unresolved" | "unassessed";
  readonly livenessConfidence: "high" | "medium" | "low" | null;
  readonly truthDisposition: "actionable" | "blocked" | "unassessed";
  readonly truthBlockers: readonly string[];
  readonly duplicateStatus: DiscoveryDuplicateStatus;
  readonly duplicateCandidateIds: readonly string[];
  readonly taxonomyConfidence: number | null;
  readonly campaignId: string | null;
  readonly updatedAt: string;
  readonly evidenceRecordIds: readonly string[];
}

export interface DiscoveryReviewListPayload {
  readonly cursor?: string | null;
  readonly limit?: number;
}

export type DiscoveryReviewPage = PagedSummaries<DiscoveryReviewItem>;

export interface ArtifactExportResponse {
  readonly outputPath: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly recoveredExisting: boolean;
}

export type TaxonomySource = "esco" | "onet";

export interface TaxonomyLicense {
  readonly name: string;
  readonly url: string;
}

export interface TaxonomyConcept {
  readonly conceptId: string;
  readonly code: string;
  readonly preferredLabel: string;
  readonly language: string;
  readonly alternateLabels: readonly string[];
  readonly description: string | null;
  readonly broaderConceptIds: readonly string[];
  readonly skillIds: readonly string[];
}

export interface TaxonomySnapshot {
  readonly snapshotId: string;
  readonly source: TaxonomySource;
  readonly version: string;
  readonly completeness: "full" | "partial";
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly publishedAt: string | null;
  readonly license: TaxonomyLicense;
  readonly conceptCount: number;
  readonly concepts: readonly TaxonomyConcept[];
  readonly contentHash: string;
  readonly provenanceHash: string;
}

export interface TaxonomySnapshotReference {
  readonly snapshotId: string;
  readonly source: TaxonomySource;
  readonly version: string;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly publishedAt: string | null;
  readonly license: TaxonomyLicense;
  readonly contentHash: string;
  readonly provenanceHash: string;
}

export interface TaxonomyConceptMatch {
  readonly conceptId: string;
  readonly score: number;
  readonly matchedLabel: string;
  readonly method: "deterministic-label-v1";
  readonly provenance: TaxonomySnapshotReference;
}

export interface TaxonomySnapshotImportSummary {
  readonly snapshotId: string;
  readonly source: TaxonomySource;
  readonly version: string;
  readonly conceptCount: number;
  readonly contentHash: string;
  readonly provenanceHash: string;
}

export interface TaxonomyImportResponse {
  readonly record: VersionedRecordSummary<"taxonomy-snapshots">;
  readonly snapshot: TaxonomySnapshotImportSummary;
  readonly artifact: ArtifactManifest;
}

export type TaxonomySnapshotImportResponse = TaxonomyImportResponse;

export interface TaxonomyQueryMatch {
  readonly query: string;
  readonly results: readonly TaxonomyConceptMatch[];
}

export interface TaxonomyQueryResponse {
  readonly snapshotId: string;
  readonly source: TaxonomySource;
  readonly version: string;
  readonly contentHash: string;
  readonly matches: readonly TaxonomyQueryMatch[];
}

export type CredentialInputFormat =
  | "json"
  | "json-ld"
  | "compact-jws"
  | "baked-png"
  | "baked-svg";

export type CredentialCheckStatus = "pass" | "fail" | "not-checked" | "not-applicable";

export interface CredentialCheck {
  readonly status: CredentialCheckStatus;
  readonly code: string;
  readonly checkedAt: string;
  readonly details: readonly string[];
}

export interface CredentialVerificationReport {
  readonly schema: CredentialCheck;
  readonly signature: CredentialCheck;
  readonly issuer: CredentialCheck;
  readonly subject: CredentialCheck;
  readonly time: CredentialCheck;
  readonly revocation: CredentialCheck;
  readonly refresh: CredentialCheck;
  readonly overall: "verified" | "rejected" | "incomplete";
  readonly eligibleForMapping: boolean;
}

export interface CredentialSummary {
  readonly credentialId: string | null;
  readonly issuerId: string | null;
  readonly subjectId: string | null;
  readonly achievementId: string | null;
  readonly achievementName: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface CredentialOriginalArtifact {
  readonly hash: string;
  readonly byteLength: number;
  readonly format: CredentialInputFormat;
  readonly mediaType: string;
}

export type CredentialClaimType =
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

export interface CredentialMappingApproval {
  readonly approvalId: string;
  readonly approverPrincipalId: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly mappingHash: string;
  readonly allowPublic: boolean;
  readonly allowAutoApply: boolean;
  readonly signatureReceiptHash: string;
}

export interface CredentialClaimMapping {
  readonly mappingId: string;
  readonly credentialId: string;
  readonly credentialHash: string;
  readonly claimType: CredentialClaimType;
  readonly claimText: string;
  readonly sourcePointer: string;
  readonly requestedPublic: boolean;
  readonly requestedAutoApply: boolean;
  readonly publiclyAssertable: boolean;
  readonly allowedInAutoApply: boolean;
  readonly status: "pending" | "approved";
  readonly mappingHash: string;
  readonly approval: CredentialMappingApproval | null;
}

export interface CredentialPassportEntry {
  readonly schemaVersion: 1;
  readonly passportEntryId: string;
  readonly importedAt: string;
  readonly original: CredentialOriginalArtifact;
  readonly envelopeFormat: "json" | "json-ld" | "compact-jws";
  readonly canonicalCredentialHash: string;
  readonly credential: JsonObject;
  readonly summary: CredentialSummary;
  readonly verification: CredentialVerificationReport;
  readonly mappings: readonly CredentialClaimMapping[];
}

export interface CredentialPassportImportSummary {
  readonly passportEntryId: string;
  readonly canonicalCredentialHash: string;
  readonly summary: CredentialSummary;
  readonly verification: CredentialVerificationReport;
}

export interface CredentialImportResponse {
  readonly record: VersionedRecordSummary<"credential-passport-records">;
  readonly passport: CredentialPassportImportSummary;
  readonly artifact: ArtifactManifest;
}

export type CredentialPassportImportResponse = CredentialImportResponse;

export interface CredentialExportResponse {
  readonly record: VersionedRecordSummary<"credential-passport-records">;
  readonly packageHash: string;
  readonly artifact: ArtifactManifest;
}

export type CredentialExportArtifactResponse = CredentialExportResponse;

export interface GetRecordPayload {
  readonly recordId: string;
}

export interface ListRecordSummariesPayload {
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface RecordValuePayload<TValue = JsonObject> {
  readonly expectedVersion: number;
  readonly value: TValue;
}

export interface ArchiveRecordPayload {
  readonly recordId: string;
  readonly expectedVersion: number;
}

export interface ArtifactImportPayload {
  readonly sourcePath: string;
}

export interface ArtifactExportPayload {
  readonly manifest: ArtifactManifest;
  readonly outputPath: string;
}

export interface TaxonomyImportPayload {
  readonly expectedVersion: number;
  readonly manifest: ArtifactManifest;
}

export interface TaxonomyQueryPayload {
  readonly snapshotId: string;
  readonly queries: readonly string[];
  readonly limit: number;
  readonly minimumScore: number;
}

export interface CredentialImportPayload {
  readonly expectedSubjectId: string | null;
  readonly expectedVersion: number;
  readonly format: CredentialInputFormat;
  readonly importedAt: string;
  readonly manifest: ArtifactManifest;
}

export interface CredentialExportPayload {
  readonly passportId: string;
  readonly exportedAt: string;
}

export interface DomainGetPayload {
  readonly domain: ProductDomainName;
  readonly recordId: string;
  readonly includeArchived?: boolean;
}

export interface DomainListPayload {
  readonly domain: ProductDomainName;
  readonly includeArchived?: boolean;
}

export interface DomainPutPayload {
  readonly domain: ProductDomainName;
  readonly value: JsonValue;
  readonly expectedVersion: number;
  readonly claimGraph?: JsonObject;
}

export interface DomainArchivePayload {
  readonly domain: ProductDomainName;
  readonly recordId: string;
  readonly expectedVersion: number;
}

export interface AutoApplyKillPayload {
  readonly reason?: string;
}

export interface AutoApplyEnablePayload {
  readonly mode: "draft-only" | "auto";
}

export interface AutoApplyEvaluatePayload {
  readonly packet: JsonObject;
  readonly claimGraph: JsonObject;
  readonly reversibilityTag: "R0" | "R1" | "R2" | "R3" | "R4";
  readonly adapterId: string;
  readonly approvalReference?: JsonObject;
  readonly riskSignals?: JsonObject;
  readonly highStakesFlags?: JsonObject;
}

export interface LegacyImportApplyPayload {
  readonly planHash: string;
}

export interface RegisterApproverPayload {
  readonly approvedBy: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface RevokeKeyPayload {
  readonly keyId: string;
}

export interface RegisterCollectorPayload {
  readonly collectorId: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly allowedAdapters: readonly string[];
  readonly allowedSourceDomains: readonly string[];
  readonly allowedKinds: readonly (
    | "confirmation-page"
    | "ats-dashboard"
    | "sent-items"
    | "receipt-email"
  )[];
}

export interface OnboardingStartPayload {
  readonly initializationMode: "demo" | "profile";
}

export interface OnboardingCompleteStepPayload {
  readonly step: string;
  readonly expectedVersion: number;
  readonly result: JsonObject;
}

export interface OnboardingStopStepPayload {
  readonly step: string;
  readonly expectedVersion: number;
  readonly reasonCode: string;
  readonly resultPointer: string;
}

export interface OnboardingResumePayload {
  readonly step: string;
  readonly expectedVersion: number;
}

export type ProfileImportFormat = "pdf" | "docx" | "markdown" | "text";

export interface ProfileImportPlanPayload {
  readonly manifest: ArtifactManifest;
  readonly format: ProfileImportFormat;
}

export interface ProfileImportApplyPayload {
  readonly planHash: string;
}

export interface TrackerCreatePayload {
  readonly input: JsonObject;
}

export interface TrackerMutationPayload {
  readonly attemptId: string;
  readonly expectedVersion: number;
}

export interface TrackerApprovePayload extends TrackerMutationPayload {
  readonly approval: JsonObject;
}

export interface TrackerBlockPayload extends TrackerMutationPayload {
  readonly blocker: string;
}

export interface TrackerConfirmPayload extends TrackerMutationPayload {
  readonly proof: JsonObject;
}

export interface CampaignListPayload {
  readonly includeArchived: boolean;
}

export interface DaemonStopResponse {
  readonly status: "shutdown-authorized";
  readonly requestedAt: string;
}

/** Legacy result that has not yet been promoted into a stable SDK DTO. */
export type UnknownAuthorityResult = unknown;

export interface AuthorityOperationContract<TPayload, TResult> {
  readonly payload: TPayload;
  readonly result: TResult;
}

type DecisionRecord<TValue = JsonObject, TDomain extends DecisionIntelligenceDomain = DecisionIntelligenceDomain> =
  VersionedAuthorityRecord<TValue, TDomain>;

type ProductRecord<TDomain extends ProductDomainName = ProductDomainName> =
  VersionedDomainRecord<JsonValue, TDomain>;

type DecisionRecordContract<TDomain extends DecisionIntelligenceDomain> =
  AuthorityOperationContract<RecordValuePayload, DecisionRecord<JsonObject, TDomain>>;

type DecisionGetContract<TDomain extends DecisionIntelligenceDomain, TValue = JsonObject> =
  AuthorityOperationContract<GetRecordPayload, DecisionRecord<TValue, TDomain> | null>;

type DecisionListContract<TDomain extends DecisionIntelligenceDomain> =
  AuthorityOperationContract<ListRecordSummariesPayload, PagedAuthorityRecordSummaries<TDomain>>;

export interface AuthorityOperationContractMap {
  readonly health: AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "daemon-stop": AuthorityOperationContract<EmptyAuthorityPayload, DaemonStopResponse>;
  readonly "auto-apply-status": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "auto-apply-kill": AuthorityOperationContract<AutoApplyKillPayload, UnknownAuthorityResult>;
  readonly "auto-apply-rearm": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "auto-apply-enable": AuthorityOperationContract<AutoApplyEnablePayload, UnknownAuthorityResult>;
  readonly "auto-apply-evaluate": AuthorityOperationContract<AutoApplyEvaluatePayload, UnknownAuthorityResult>;
  readonly "legacy-import-plan": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "legacy-import-apply": AuthorityOperationContract<LegacyImportApplyPayload, UnknownAuthorityResult>;
  readonly "checkpoint-create": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "checkpoint-verify": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "approver-list": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "approver-register": AuthorityOperationContract<RegisterApproverPayload, UnknownAuthorityResult>;
  readonly "approver-revoke": AuthorityOperationContract<RevokeKeyPayload, UnknownAuthorityResult>;
  readonly "collector-list": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "collector-register": AuthorityOperationContract<RegisterCollectorPayload, UnknownAuthorityResult>;
  readonly "collector-revoke": AuthorityOperationContract<RevokeKeyPayload, UnknownAuthorityResult>;
  readonly "audit-export": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "network-grant-register": AuthorityOperationContract<NetworkGrantRegisterPayload, NetworkAccessGrantSummary>;
  readonly "network-grant-list": AuthorityOperationContract<ListRecordSummariesPayload, PagedSummaries<NetworkAccessGrantSummary>>;
  readonly "discovery-run": AuthorityOperationContract<DiscoveryRunPayload, DiscoveryRunResponse>;
  readonly "discovery-review-list": AuthorityOperationContract<DiscoveryReviewListPayload, DiscoveryReviewPage>;
  readonly "source-observation-record": DecisionRecordContract<"source-observations">;
  readonly "source-observation-get": DecisionGetContract<"source-observations">;
  readonly "source-observation-list": DecisionListContract<"source-observations">;
  readonly "opportunity-truth-record": DecisionRecordContract<"opportunity-truth-records">;
  readonly "opportunity-truth-get": DecisionGetContract<"opportunity-truth-records">;
  readonly "opportunity-truth-list": DecisionListContract<"opportunity-truth-records">;
  readonly "liveness-assessment-record": DecisionRecordContract<"liveness-assessments">;
  readonly "liveness-assessment-get": DecisionGetContract<"liveness-assessments">;
  readonly "liveness-assessment-list": DecisionListContract<"liveness-assessments">;
  readonly "dedupe-result-record": DecisionRecordContract<"dedupe-results">;
  readonly "dedupe-result-get": DecisionGetContract<"dedupe-results">;
  readonly "dedupe-result-list": DecisionListContract<"dedupe-results">;
  readonly "taxonomy-snapshot-record": AuthorityOperationContract<never, never>;
  readonly "taxonomy-snapshot-import-artifact": AuthorityOperationContract<TaxonomyImportPayload, TaxonomyImportResponse>;
  readonly "taxonomy-snapshot-get": DecisionGetContract<"taxonomy-snapshots", TaxonomySnapshot>;
  readonly "taxonomy-snapshot-list": DecisionListContract<"taxonomy-snapshots">;
  readonly "taxonomy-query": AuthorityOperationContract<TaxonomyQueryPayload, TaxonomyQueryResponse>;
  readonly "taxonomy-mapping-record": DecisionRecordContract<"taxonomy-mapping-sets">;
  readonly "taxonomy-mapping-get": DecisionGetContract<"taxonomy-mapping-sets">;
  readonly "taxonomy-mapping-list": DecisionListContract<"taxonomy-mapping-sets">;
  readonly "assurance-case-record": DecisionRecordContract<"career-assurance-cases">;
  readonly "assurance-case-get": DecisionGetContract<"career-assurance-cases">;
  readonly "assurance-case-list": DecisionListContract<"career-assurance-cases">;
  readonly "credential-passport-record": AuthorityOperationContract<never, never>;
  readonly "credential-import-artifact": AuthorityOperationContract<CredentialImportPayload, CredentialImportResponse>;
  readonly "credential-export-artifact": AuthorityOperationContract<CredentialExportPayload, CredentialExportResponse>;
  readonly "credential-passport-get": DecisionGetContract<"credential-passport-records", CredentialPassportEntry>;
  readonly "credential-passport-list": DecisionListContract<"credential-passport-records">;
  readonly "credential-mapping-record": DecisionRecordContract<"credential-mapping-plans">;
  readonly "credential-mapping-get": DecisionGetContract<"credential-mapping-plans">;
  readonly "credential-mapping-list": DecisionListContract<"credential-mapping-plans">;
  readonly "campaign-record": AuthorityOperationContract<RecordValuePayload, ProductRecord<"campaigns">>;
  readonly "campaign-get": AuthorityOperationContract<GetRecordPayload, ProductRecord<"campaigns"> | null>;
  readonly "campaign-list": AuthorityOperationContract<CampaignListPayload, readonly ProductRecord<"campaigns">[]>;
  readonly "campaign-archive": AuthorityOperationContract<ArchiveRecordPayload, ProductRecord<"campaigns">>;
  readonly "outcome-record": AuthorityOperationContract<RecordValuePayload, ProductRecord<"outcomes">>;
  readonly "outcome-get": AuthorityOperationContract<GetRecordPayload, ProductRecord<"outcomes"> | null>;
  readonly "outcome-list": AuthorityOperationContract<CampaignListPayload, readonly ProductRecord<"outcomes">[]>;
  readonly "outcome-archive": AuthorityOperationContract<ArchiveRecordPayload, ProductRecord<"outcomes">>;
  readonly "domain-get": AuthorityOperationContract<DomainGetPayload, ProductRecord | null>;
  readonly "domain-list": AuthorityOperationContract<DomainListPayload, readonly ProductRecord[]>;
  readonly "domain-put": AuthorityOperationContract<DomainPutPayload, ProductRecord>;
  readonly "domain-archive": AuthorityOperationContract<DomainArchivePayload, ProductRecord>;
  readonly "artifact-list": AuthorityOperationContract<EmptyAuthorityPayload, readonly ArtifactManifest[]>;
  readonly "artifact-import": AuthorityOperationContract<ArtifactImportPayload, ArtifactManifest>;
  readonly "artifact-export": AuthorityOperationContract<ArtifactExportPayload, ArtifactExportResponse>;
  readonly "onboarding-status": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "onboarding-start": AuthorityOperationContract<OnboardingStartPayload, UnknownAuthorityResult>;
  readonly "onboarding-complete-step": AuthorityOperationContract<OnboardingCompleteStepPayload, UnknownAuthorityResult>;
  readonly "onboarding-fail": AuthorityOperationContract<OnboardingStopStepPayload, UnknownAuthorityResult>;
  readonly "onboarding-cancel": AuthorityOperationContract<OnboardingStopStepPayload, UnknownAuthorityResult>;
  readonly "onboarding-resume": AuthorityOperationContract<OnboardingResumePayload, UnknownAuthorityResult>;
  readonly "profile-import-plan": AuthorityOperationContract<ProfileImportPlanPayload, UnknownAuthorityResult>;
  readonly "profile-import-plan-get": AuthorityOperationContract<EmptyAuthorityPayload, UnknownAuthorityResult>;
  readonly "profile-import-apply": AuthorityOperationContract<ProfileImportApplyPayload, ProductRecord<"profiles">>;
  readonly "tracker-list": AuthorityOperationContract<Pick<DomainListPayload, "includeArchived">, readonly ProductRecord<"applications">[]>;
  readonly "tracker-get": AuthorityOperationContract<{ readonly attemptId: string }, ProductRecord<"applications"> | null>;
  readonly "tracker-create": AuthorityOperationContract<TrackerCreatePayload, ProductRecord<"applications">>;
  readonly "tracker-approve": AuthorityOperationContract<TrackerApprovePayload, ProductRecord<"applications">>;
  readonly "tracker-submit": AuthorityOperationContract<TrackerMutationPayload, ProductRecord<"applications">>;
  readonly "tracker-block": AuthorityOperationContract<TrackerBlockPayload, ProductRecord<"applications">>;
  readonly "tracker-confirm": AuthorityOperationContract<TrackerConfirmPayload, ProductRecord<"applications">>;
}

export type AuthorityOperationPayload<O extends AuthorityOperation> =
  AuthorityOperationContractMap[O]["payload"];

export type AuthorityOperationResult<O extends AuthorityOperation> =
  AuthorityOperationContractMap[O]["result"];

export type OperationPayload<O extends AuthorityOperation> = AuthorityOperationPayload<O>;
export type OperationResult<O extends AuthorityOperation> = AuthorityOperationResult<O>;

export type AuthorityRequestEnvelope<O extends AuthorityOperation = AuthorityOperation> =
  O extends AuthorityOperation
    ? {
        readonly id: string;
        readonly operation: O;
        readonly payload: AuthorityOperationPayload<O>;
      }
    : never;

export type VocationTransportRequest<O extends AuthorityOperation = AuthorityOperation> =
  O extends AuthorityOperation
    ? {
        readonly operation: O;
        readonly payload: AuthorityOperationPayload<O>;
        readonly requestId?: string;
        readonly timeoutMs?: number;
      }
    : never;

export interface VocationTransport {
  execute<O extends AuthorityOperation>(
    request: VocationTransportRequest<O>
  ): Promise<AuthorityOperationResult<O>>;
}

export interface VocationRequestOptions {
  readonly requestId?: string;
  readonly timeoutMs?: number;
}

export type VocationRequestArguments<O extends AuthorityOperation> =
  [AuthorityOperationPayload<O>] extends [never]
    ? [payload: never, options?: VocationRequestOptions]
    : AuthorityOperationPayload<O> extends EmptyAuthorityPayload
      ? [payload?: AuthorityOperationPayload<O>, options?: VocationRequestOptions]
      : [payload: AuthorityOperationPayload<O>, options?: VocationRequestOptions];

export class VocationClient {
  public constructor(private readonly transport: VocationTransport) {}

  public request<O extends AuthorityOperation>(
    operation: O,
    ...args: VocationRequestArguments<O>
  ): Promise<AuthorityOperationResult<O>>;

  public request<O extends AuthorityOperation>(
    operation: O,
    payload: AuthorityOperationPayload<O>,
    options?: VocationRequestOptions
  ): Promise<AuthorityOperationResult<O>>;

  public request<O extends AuthorityOperation>(
    operation: O,
    payload: AuthorityOperation extends O ? unknown : never,
    options?: VocationRequestOptions
  ): Promise<AuthorityOperationResult<O>>;

  public async request(
    operation: AuthorityOperation,
    payload: unknown = {},
    options: VocationRequestOptions = {}
  ): Promise<unknown> {
    const request = {
      operation,
      payload,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    } as VocationTransportRequest;
    return this.transport.execute(request);
  }
}
