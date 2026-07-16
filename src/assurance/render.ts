import { sha256, stableStringify } from "../hash.js";
import { assertAssuranceSchema } from "./schema.js";
import type {
  AssuranceDocumentAstInput,
  AssuranceDocumentNode,
  AssuranceEvaluation,
  AssuranceRenderOptions,
  CareerAssuranceCase
} from "./types.js";

interface DisclosureView {
  assuranceCase: CareerAssuranceCase;
  redactedEvidenceCount: number;
  redactedNarrativeCount: number;
}

function disclosureView(
  assuranceCase: CareerAssuranceCase,
  includePrivateEvidence: boolean
): DisclosureView {
  if (includePrivateEvidence) {
    return {
      assuranceCase: structuredClone(assuranceCase),
      redactedEvidenceCount: 0,
      redactedNarrativeCount: 0
    };
  }
  const visibleEvidence = assuranceCase.evidence.filter((entry) => entry.disclosure === "public");
  const visibleEvidenceIds = new Set(visibleEvidence.map((entry) => entry.evidenceId));
  const redactedNarrativeCount = [
    assuranceCase.decision,
    ...assuranceCase.uncertainties,
    ...assuranceCase.defeaters,
    ...assuranceCase.policies
  ].filter((entry) => entry.disclosure === "private").length;
  return {
    assuranceCase: {
      ...structuredClone(assuranceCase),
      decision: assuranceCase.decision.disclosure === "private"
        ? { ...assuranceCase.decision, statement: "[redacted]" }
        : { ...assuranceCase.decision },
      evidence: visibleEvidence.map((entry) => ({ ...entry })),
      uncertainties: assuranceCase.uncertainties.map((entry) => ({
        ...entry,
        description: entry.disclosure === "private" ? "[redacted]" : entry.description,
        evidenceIds: entry.evidenceIds.filter((evidenceId) => visibleEvidenceIds.has(evidenceId))
      })),
      defeaters: assuranceCase.defeaters.map((entry) => ({
        ...entry,
        description: entry.disclosure === "private" ? "[redacted]" : entry.description,
        resolution: entry.disclosure === "private" && entry.resolution !== null ? "[redacted]" : entry.resolution,
        evidenceIds: entry.evidenceIds.filter((evidenceId) => visibleEvidenceIds.has(evidenceId))
      })),
      policies: assuranceCase.policies.map((entry) => ({
        ...entry,
        rationale: entry.disclosure === "private" ? "[redacted]" : entry.rationale
      }))
    },
    redactedEvidenceCount: assuranceCase.evidence.length - visibleEvidence.length,
    redactedNarrativeCount
  };
}

function generatedAt(assuranceCase: CareerAssuranceCase, options: AssuranceRenderOptions): string {
  const value = options.generatedAt ?? assuranceCase.createdAt;
  if (!Number.isFinite(Date.parse(value))) throw new Error("Assurance render time is invalid");
  return value;
}

function compactText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function markdownCell(value: string): string {
  return compactText(value).replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|");
}

function markdownTable(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const header = `| ${columns.map(markdownCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  return [
    header,
    separator,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)
  ].join("\n");
}

export function renderCareerAssuranceCaseJson(
  assuranceCase: CareerAssuranceCase,
  evaluation: AssuranceEvaluation,
  options: AssuranceRenderOptions = {}
): string {
  assertAssuranceSchema("assurance-case", assuranceCase);
  const disclosed = disclosureView(assuranceCase, options.includePrivateEvidence ?? false);
  const exportedAt = generatedAt(assuranceCase, options);
  const exportPayload = {
    schemaVersion: 1,
    exportType: "career-assurance-case",
    exportedAt,
    integrityMode: disclosed.redactedEvidenceCount === 0 && disclosed.redactedNarrativeCount === 0
      ? "complete-case"
      : "redacted-view",
    sourceCaseHash: assuranceCase.caseHash,
    disclosureHash: sha256(stableStringify(disclosed.assuranceCase)),
    redactions: {
      privateEvidence: disclosed.redactedEvidenceCount,
      privateNarratives: disclosed.redactedNarrativeCount,
      marker: disclosed.redactedEvidenceCount > 0 || disclosed.redactedNarrativeCount > 0 ? "[redacted]" : null
    },
    evaluation,
    assuranceCase: disclosed.assuranceCase
  };
  return `${JSON.stringify(JSON.parse(stableStringify(exportPayload)), null, 2)}\n`;
}

export function renderCareerAssuranceCaseMarkdown(
  assuranceCase: CareerAssuranceCase,
  evaluation: AssuranceEvaluation,
  options: AssuranceRenderOptions = {}
): string {
  assertAssuranceSchema("assurance-case", assuranceCase);
  const disclosed = disclosureView(assuranceCase, options.includePrivateEvidence ?? false);
  const visible = disclosed.assuranceCase;
  const lines = [
    `# Career Assurance Case ${markdownCell(assuranceCase.caseId)}`,
    "",
    `Generated: ${markdownCell(generatedAt(assuranceCase, options))}`,
    `Recommendation: ${markdownCell(assuranceCase.decision.recommendation)}`,
    `Valid: ${String(evaluation.valid)}`,
    `Actionable: ${String(evaluation.actionable)}`,
    `Independently certified: ${String(evaluation.certified)}`,
    `Status: ${evaluation.valid && evaluation.actionable ? "VALID AND ACTIONABLE" : "NOT ACTIONABLE"}`,
    `Private evidence redacted: ${disclosed.redactedEvidenceCount}`,
    `Private narratives redacted: ${disclosed.redactedNarrativeCount}`,
    "",
    "## Decision",
    "",
    compactText(visible.decision.statement),
    "",
    markdownTable(
      ["Decision", "Route", "Reversibility", "High stakes"],
      [[
        assuranceCase.decision.decisionId,
        assuranceCase.decision.routeId,
        assuranceCase.decision.reversibility,
        String(assuranceCase.decision.highStakes)
      ]]
    ),
    "",
    "## Evidence",
    "",
    visible.evidence.length === 0
      ? "No evidence is available in this disclosure view."
      : markdownTable(
        ["Evidence", "Claim", "Source", "Observed", "Fresh until", "Claim hash", "Source hash"],
        visible.evidence.map((entry) => [
          entry.evidenceId,
          entry.claimId,
          entry.sourceId,
          entry.observedAt,
          entry.freshUntil,
          entry.claimHash,
          entry.sourceHash
        ])
      ),
    "",
    "## Uncertainty",
    "",
    visible.uncertainties.length === 0
      ? "No uncertainty recorded."
      : markdownTable(
        ["Uncertainty", "Material", "Status", "Description", "Evidence"],
        visible.uncertainties.map((entry) => [
          entry.uncertaintyId,
          String(entry.material),
          entry.status,
          entry.description,
          entry.evidenceIds.join(", ")
        ])
      ),
    "",
    "## Defeaters",
    "",
    visible.defeaters.length === 0
      ? "No defeaters recorded."
      : markdownTable(
        ["Defeater", "Kind", "Status", "Description", "Resolution", "Evidence"],
        visible.defeaters.map((entry) => [
          entry.defeaterId,
          entry.kind,
          entry.status,
          entry.description,
          entry.resolution ?? "",
          entry.evidenceIds.join(", ")
        ])
      ),
    "",
    "## Policy",
    "",
    markdownTable(
      ["Policy", "Outcome", "Version", "Evaluated", "Rationale"],
      visible.policies.map((entry) => [
        entry.policyId,
        entry.outcome,
        entry.policyVersionHash,
        entry.evaluatedAt,
        entry.rationale
      ])
    ),
    "",
    "## Approval and Receipts",
    "",
    assuranceCase.approvals.length === 0
      ? "No approval recorded."
      : markdownTable(
        ["Approval", "Approver", "Approved", "Expires", "Scope", "Acknowledged soft defeaters"],
        assuranceCase.approvals.map((entry) => [
          entry.approvalId,
          entry.approverPrincipalId,
          entry.approvedAt,
          entry.expiresAt,
          entry.scopeHash,
          entry.acknowledgedSoftDefeaterIds.join(", ")
        ])
      ),
    "",
    assuranceCase.receipts.length === 0
      ? "No action receipt recorded."
      : markdownTable(
        ["Receipt", "Operation", "Outcome", "Occurred", "Approval", "Event hash"],
        assuranceCase.receipts.map((entry) => [
          entry.receiptId,
          entry.operation,
          entry.outcome,
          entry.occurredAt,
          entry.approvalId ?? "",
          entry.eventHash
        ])
      ),
    "",
    "## Version and Integrity",
    "",
    markdownTable(
      ["Model", "Policy set", "Taxonomy", "Data snapshot", "Generator build"],
      [[
        assuranceCase.versions.modelHash,
        assuranceCase.versions.policySetHash,
        assuranceCase.versions.taxonomyHash,
        assuranceCase.versions.dataSnapshotHash,
        assuranceCase.versions.generatorBuildHash
      ]]
    ),
    "",
    `Binding hash: ${assuranceCase.bindingHash}`,
    `Case hash: ${assuranceCase.caseHash}`,
    `Evaluation hash: ${evaluation.evaluationHash}`,
    "",
    "## Evaluation Reasons",
    "",
    evaluation.reasons.length === 0
      ? "No invalidation or action blocking reason recorded."
      : markdownTable(
        ["Code", "Subject", "Expected", "Actual"],
        evaluation.reasons.map((entry) => [
          entry.code,
          entry.subjectId,
          entry.expected ?? "",
          entry.actual ?? ""
        ])
      )
  ];
  return `${lines.join("\n").trim()}\n`;
}

function heading(nodeId: string, level: 1 | 2 | 3, text: string): AssuranceDocumentNode {
  return { nodeId, type: "heading", level, text };
}

function paragraph(nodeId: string, text: string): AssuranceDocumentNode {
  return { nodeId, type: "paragraph", text: compactText(text) };
}

function table(
  nodeId: string,
  columns: string[],
  rows: string[][]
): AssuranceDocumentNode {
  if (rows.some((row) => row.length !== columns.length)) {
    throw new Error(`Assurance document table ${nodeId} has inconsistent row widths`);
  }
  return { nodeId, type: "table", columns, rows };
}

export function toAssuranceDocumentAstInput(
  assuranceCase: CareerAssuranceCase,
  evaluation: AssuranceEvaluation,
  options: AssuranceRenderOptions = {}
): AssuranceDocumentAstInput {
  assertAssuranceSchema("assurance-case", assuranceCase);
  const disclosed = disclosureView(assuranceCase, options.includePrivateEvidence ?? false);
  const visible = disclosed.assuranceCase;
  const nodes: AssuranceDocumentNode[] = [
    heading("NODE-ASSURANCE-DECISION", 1, "Decision"),
    paragraph("NODE-ASSURANCE-DECISION-TEXT", visible.decision.statement),
    table(
      "NODE-ASSURANCE-DECISION-TABLE",
      ["Recommendation", "Route", "Reversibility", "High stakes"],
      [[
        assuranceCase.decision.recommendation,
        assuranceCase.decision.routeId,
        assuranceCase.decision.reversibility,
        String(assuranceCase.decision.highStakes)
      ]]
    ),
    heading("NODE-ASSURANCE-EVIDENCE", 1, "Evidence"),
    table(
      "NODE-ASSURANCE-EVIDENCE-TABLE",
      ["Evidence", "Claim", "Source", "Observed", "Fresh until"],
      visible.evidence.map((entry) => [
        entry.evidenceId,
        entry.claimId,
        entry.sourceId,
        entry.observedAt,
        entry.freshUntil
      ])
    ),
    heading("NODE-ASSURANCE-UNCERTAINTY", 1, "Uncertainty and Defeaters"),
    table(
      "NODE-ASSURANCE-UNCERTAINTY-TABLE",
      ["Identifier", "Class", "Status", "Description"],
      [
        ...visible.uncertainties.map((entry) => [
          entry.uncertaintyId,
          entry.material ? "material uncertainty" : "uncertainty",
          entry.status,
          compactText(entry.description)
        ]),
        ...visible.defeaters.map((entry) => [
          entry.defeaterId,
          `${entry.kind} defeater`,
          entry.status,
          compactText(entry.description)
        ])
      ]
    ),
    heading("NODE-ASSURANCE-POLICY", 1, "Policy, Approval, and Receipts"),
    table(
      "NODE-ASSURANCE-POLICY-TABLE",
      ["Policy", "Outcome", "Version", "Rationale"],
      visible.policies.map((entry) => [
        entry.policyId,
        entry.outcome,
        entry.policyVersionHash,
        compactText(entry.rationale)
      ])
    ),
    table(
      "NODE-ASSURANCE-APPROVAL-TABLE",
      ["Approval", "Approver", "Expires", "Scope"],
      assuranceCase.approvals.map((entry) => [
        entry.approvalId,
        entry.approverPrincipalId,
        entry.expiresAt,
        entry.scopeHash
      ])
    ),
    table(
      "NODE-ASSURANCE-RECEIPT-TABLE",
      ["Receipt", "Operation", "Outcome", "Event hash"],
      assuranceCase.receipts.map((entry) => [
        entry.receiptId,
        entry.operation,
        entry.outcome,
        entry.eventHash
      ])
    ),
    heading("NODE-ASSURANCE-INTEGRITY", 1, "Integrity and Evaluation"),
    paragraph(
      "NODE-ASSURANCE-INTEGRITY-TEXT",
      `Valid ${String(evaluation.valid)}. Actionable ${String(evaluation.actionable)}. `
        + `Independently certified ${String(evaluation.certified)}. Private evidence redacted ${disclosed.redactedEvidenceCount}. `
        + `Private narratives redacted ${disclosed.redactedNarrativeCount}.`
    ),
    table(
      "NODE-ASSURANCE-HASH-TABLE",
      ["Binding hash", "Case hash", "Evaluation hash"],
      [[assuranceCase.bindingHash, assuranceCase.caseHash, evaluation.evaluationHash]]
    ),
    table(
      "NODE-ASSURANCE-REASON-TABLE",
      ["Code", "Subject", "Expected", "Actual"],
      evaluation.reasons.map((entry) => [
        entry.code,
        entry.subjectId,
        entry.expected ?? "",
        entry.actual ?? ""
      ])
    )
  ];
  const document: AssuranceDocumentAstInput = {
    schemaVersion: 1,
    documentId: `DOC-ASSURANCE-${assuranceCase.caseHash.slice("sha256:".length, "sha256:".length + 20).toUpperCase()}`,
    documentType: "career-assurance-case",
    title: `Career Assurance Case ${assuranceCase.caseId}`,
    generatedAt: generatedAt(assuranceCase, options),
    metadata: {
      caseId: assuranceCase.caseId,
      caseHash: assuranceCase.caseHash,
      bindingHash: assuranceCase.bindingHash,
      recommendation: assuranceCase.decision.recommendation,
      valid: evaluation.valid,
      actionable: evaluation.actionable,
      certified: evaluation.certified,
      redactedEvidenceCount: disclosed.redactedEvidenceCount,
      redactedNarrativeCount: disclosed.redactedNarrativeCount
    },
    layout: { pageSize: "A4", marginPoints: 48, bodyFontSize: 10.5 },
    nodes
  };
  assertAssuranceSchema("assurance-document-ast", document);
  return document;
}

export const renderAssuranceCaseJson = renderCareerAssuranceCaseJson;
export const renderAssuranceCaseMarkdown = renderCareerAssuranceCaseMarkdown;
export const toAssuranceDocumentAst = toAssuranceDocumentAstInput;
