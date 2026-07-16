export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type CredentialInputFormat = "json" | "json-ld" | "compact-jws" | "baked-png" | "baked-svg";
export type CredentialEnvelopeFormat = "json" | "json-ld" | "compact-jws";
export type CredentialCheckStatus = "pass" | "fail" | "not-checked" | "not-applicable";

export interface CredentialImportSource {
  content: string | Uint8Array;
  format?: CredentialInputFormat;
  mediaType?: string;
}

export interface CredentialOriginalArtifact {
  hash: string;
  byteLength: number;
  format: CredentialInputFormat;
  mediaType: string;
}

export interface CredentialCheck {
  status: CredentialCheckStatus;
  code: string;
  checkedAt: string;
  details: string[];
}

export interface CredentialVerificationReport {
  schema: CredentialCheck;
  signature: CredentialCheck;
  issuer: CredentialCheck;
  subject: CredentialCheck;
  time: CredentialCheck;
  revocation: CredentialCheck;
  refresh: CredentialCheck;
  overall: "verified" | "rejected" | "incomplete";
  eligibleForMapping: boolean;
}

export interface CredentialSummary {
  credentialId: string | null;
  issuerId: string | null;
  subjectId: string | null;
  achievementId: string | null;
  achievementName: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

export interface CredentialPassportEntry {
  schemaVersion: 1;
  passportEntryId: string;
  importedAt: string;
  original: CredentialOriginalArtifact;
  envelopeFormat: CredentialEnvelopeFormat;
  canonicalCredentialHash: string;
  credential: JsonObject;
  summary: CredentialSummary;
  verification: CredentialVerificationReport;
  mappings: CredentialClaimMapping[];
}

export interface PreservedCredentialArtifact extends CredentialOriginalArtifact {
  bytes: Uint8Array;
}

export interface CredentialImportResult {
  entry: CredentialPassportEntry;
  preservedOriginal: PreservedCredentialArtifact;
}

export type CredentialDocumentPurpose =
  | "context"
  | "schema"
  | "verification-method"
  | "issuer"
  | "status"
  | "refresh";

export interface CredentialDocumentRequest {
  url: string;
  purpose: CredentialDocumentPurpose;
  maxBytes: number;
}

export interface CredentialLoadedDocument {
  url: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface CredentialDocumentLoader {
  load(request: CredentialDocumentRequest): Promise<CredentialLoadedDocument>;
}

export interface CompactJwsVerificationRequest {
  compactJws: string;
  signingInput: string;
  signature: Uint8Array;
  algorithm: string;
  keyId: string | null;
  header: JsonObject;
  payload: JsonObject;
  credential: JsonObject;
}

export interface DataIntegrityVerificationRequest {
  credential: JsonObject;
  proofs: JsonObject[];
  allowedCryptosuites: readonly string[];
}

export interface CredentialCryptoVerificationResult {
  valid: boolean;
  algorithm: string;
  signerId: string | null;
  keyId: string | null;
  reasons: string[];
}

export interface CredentialCryptoVerifier {
  verifyCompactJws(
    request: CompactJwsVerificationRequest,
    loader: CredentialDocumentLoader
  ): Promise<CredentialCryptoVerificationResult>;
  verifyDataIntegrity(
    request: DataIntegrityVerificationRequest,
    loader: CredentialDocumentLoader
  ): Promise<CredentialCryptoVerificationResult>;
}

export interface CredentialSchemaVerificationResult {
  valid: boolean;
  reasons: string[];
}

export interface CredentialSchemaVerifier {
  validate(
    credential: JsonObject,
    loader: CredentialDocumentLoader
  ): Promise<CredentialSchemaVerificationResult>;
}

export interface CredentialRevocationResult {
  checked: boolean;
  revoked: boolean;
  reasons: string[];
}

export interface CredentialRefreshResult {
  checked: boolean;
  valid: boolean;
  refreshedCredentialHash: string | null;
  reasons: string[];
}

export interface CredentialStatusVerifier {
  checkRevocation(
    credential: JsonObject,
    status: JsonObject,
    loader: CredentialDocumentLoader
  ): Promise<CredentialRevocationResult>;
  checkRefresh(
    credential: JsonObject,
    refreshService: JsonObject,
    loader: CredentialDocumentLoader
  ): Promise<CredentialRefreshResult>;
}

export interface CredentialImportDependencies {
  documentLoader?: CredentialDocumentLoader;
  cryptoVerifier?: CredentialCryptoVerifier;
  schemaVerifier?: CredentialSchemaVerifier;
  statusVerifier?: CredentialStatusVerifier;
}

export interface CredentialImportOptions {
  now?: Date;
  expectedSubjectId?: string;
  maxInputBytes?: number;
  maxEmbeddedCredentialBytes?: number;
  maxDocumentBytes?: number;
  maxJsonDepth?: number;
  allowedAlgorithms?: readonly string[];
  allowedCryptosuites?: readonly string[];
  allowedContextUrls?: readonly string[];
  allowedDocumentUrls?: readonly string[];
}

export interface CredentialClaimMappingDraft {
  mappingId: string;
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
  claimText: string;
  requestedPublic?: boolean;
  requestedAutoApply?: boolean;
}

export interface CredentialMappingApproval {
  approvalId: string;
  approverPrincipalId: string;
  approvedAt: string;
  expiresAt: string;
  mappingHash: string;
  allowPublic: boolean;
  allowAutoApply: boolean;
  signatureReceiptHash: string;
}

export interface CredentialClaimMapping {
  mappingId: string;
  credentialId: string;
  credentialHash: string;
  claimType: CredentialClaimMappingDraft["claimType"];
  claimText: string;
  sourcePointer: string;
  requestedPublic: boolean;
  requestedAutoApply: boolean;
  publiclyAssertable: boolean;
  allowedInAutoApply: boolean;
  status: "pending" | "approved";
  mappingHash: string;
  approval: CredentialMappingApproval | null;
}
