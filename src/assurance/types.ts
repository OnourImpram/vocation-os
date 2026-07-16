export type AssuranceRecommendation = "proceed" | "defer" | "decline";
export type AssuranceDefeaterKind = "hard" | "soft";
export type AssuranceDefeaterStatus = "unresolved" | "resolved" | "accepted";
export type AssuranceDisclosure = "private" | "public";

export interface AssuranceDecision {
  decisionId: string;
  routeId: string;
  recommendation: AssuranceRecommendation;
  statement: string;
  reversibility: "R0" | "R1" | "R2" | "R3" | "R4";
  highStakes: boolean;
  disclosure: AssuranceDisclosure;
}

export interface AssuranceEvidenceBinding {
  evidenceId: string;
  claimId: string;
  claimHash: string;
  sourceId: string;
  sourceHash: string;
  observedAt: string;
  freshUntil: string;
  disclosure: AssuranceDisclosure;
}

export interface AssuranceUncertainty {
  uncertaintyId: string;
  description: string;
  material: boolean;
  status: "unresolved" | "resolved";
  evidenceIds: string[];
  disclosure: AssuranceDisclosure;
}

export interface AssuranceDefeater {
  defeaterId: string;
  kind: AssuranceDefeaterKind;
  description: string;
  status: AssuranceDefeaterStatus;
  evidenceIds: string[];
  resolution: string | null;
  disclosure: AssuranceDisclosure;
}

export interface AssurancePolicyDecision {
  policyId: string;
  policyVersionHash: string;
  outcome: "allow" | "deny" | "manual-review";
  rationale: string;
  evaluatedAt: string;
  disclosure: AssuranceDisclosure;
}

export interface AssuranceApproval {
  approvalId: string;
  approverPrincipalId: string;
  approvedAt: string;
  expiresAt: string;
  scopeHash: string;
  acknowledgedSoftDefeaterIds: string[];
  signatureReceiptHash: string;
}

export interface AssuranceActionReceipt {
  receiptId: string;
  operation: string;
  outcome: "succeeded" | "failed" | "blocked";
  occurredAt: string;
  requestHash: string;
  resultHash: string;
  eventHash: string;
  scopeHash: string;
  approvalId: string | null;
}

export interface AssuranceVersionHashes {
  modelHash: string;
  policySetHash: string;
  taxonomyHash: string;
  dataSnapshotHash: string;
  generatorBuildHash: string;
}

export interface AssuranceGenerator {
  principalId: string;
  componentId: string;
  generatedAt: string;
}

export interface AssuranceCertification {
  certifierPrincipalId: string;
  certifierComponentId: string;
  certifiedAt: string;
  certifiedCaseHash: string;
  signatureReceiptHash: string;
}

export interface CareerAssuranceCase {
  schemaVersion: 1;
  caseId: string;
  createdAt: string;
  decision: AssuranceDecision;
  evidence: AssuranceEvidenceBinding[];
  uncertainties: AssuranceUncertainty[];
  defeaters: AssuranceDefeater[];
  policies: AssurancePolicyDecision[];
  approvals: AssuranceApproval[];
  receipts: AssuranceActionReceipt[];
  versions: AssuranceVersionHashes;
  generator: AssuranceGenerator;
  bindingHash: string;
  caseHash: string;
  certification: AssuranceCertification | null;
}

export type CareerAssuranceCaseDraft = Omit<
  CareerAssuranceCase,
  "schemaVersion" | "bindingHash" | "caseHash" | "certification"
>;

export type AssuranceCurrentEvidence = Pick<AssuranceEvidenceBinding, "claimHash" | "sourceHash">;

export interface AssuranceCurrentState {
  evidence: Readonly<Record<string, AssuranceCurrentEvidence>>;
  policyVersions: Readonly<Record<string, string>>;
  versions: AssuranceVersionHashes;
}

export interface AssuranceEvaluationReason {
  code: string;
  subjectId: string;
  expected: string | null;
  actual: string | null;
}

export interface AssuranceEvaluation {
  valid: boolean;
  actionable: boolean;
  certified: boolean;
  reasons: AssuranceEvaluationReason[];
  evaluationHash: string;
}

export interface AssuranceCertificationDraft {
  certifierPrincipalId: string;
  certifierComponentId: string;
  certifiedAt: string;
  signatureReceiptHash: string;
}

export interface AssuranceEvaluationOptions {
  currentState?: AssuranceCurrentState;
  now?: Date;
  requireCertification?: boolean;
}

export interface AssuranceRenderOptions {
  includePrivateEvidence?: boolean;
  generatedAt?: string;
}

export interface AssuranceDocumentMetadata {
  caseId: string;
  caseHash: string;
  bindingHash: string;
  recommendation: AssuranceRecommendation;
  valid: boolean;
  actionable: boolean;
  certified: boolean;
  redactedEvidenceCount: number;
  redactedNarrativeCount: number;
}

export interface AssuranceDocumentHeadingNode {
  nodeId: string;
  type: "heading";
  level: 1 | 2 | 3;
  text: string;
}

export interface AssuranceDocumentParagraphNode {
  nodeId: string;
  type: "paragraph";
  text: string;
}

export interface AssuranceDocumentTableNode {
  nodeId: string;
  type: "table";
  columns: string[];
  rows: string[][];
}

export type AssuranceDocumentNode =
  | AssuranceDocumentHeadingNode
  | AssuranceDocumentParagraphNode
  | AssuranceDocumentTableNode;

export interface AssuranceDocumentAstInput {
  schemaVersion: 1;
  documentId: string;
  documentType: "career-assurance-case";
  title: string;
  generatedAt: string;
  metadata: AssuranceDocumentMetadata;
  layout: {
    pageSize: "A4" | "LETTER";
    marginPoints: number;
    bodyFontSize: number;
  };
  nodes: AssuranceDocumentNode[];
}
