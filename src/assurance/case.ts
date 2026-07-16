import { sha256, stableStringify } from "../hash.js";
import { assertAssuranceSchema, validateAssuranceSchema } from "./schema.js";
import type {
  AssuranceApproval,
  AssuranceCertificationDraft,
  AssuranceCurrentState,
  AssuranceDefeater,
  AssuranceEvaluation,
  AssuranceEvaluationOptions,
  AssuranceEvaluationReason,
  AssurancePolicyDecision,
  AssuranceVersionHashes,
  CareerAssuranceCase,
  CareerAssuranceCaseDraft
} from "./types.js";

const MAX_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeDraft(draft: CareerAssuranceCaseDraft): CareerAssuranceCaseDraft {
  return {
    caseId: draft.caseId,
    createdAt: draft.createdAt,
    decision: { ...draft.decision },
    evidence: draft.evidence
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    uncertainties: draft.uncertainties
      .map((entry) => ({ ...entry, evidenceIds: sortedUnique(entry.evidenceIds) }))
      .sort((left, right) => left.uncertaintyId.localeCompare(right.uncertaintyId)),
    defeaters: draft.defeaters
      .map((entry) => ({ ...entry, evidenceIds: sortedUnique(entry.evidenceIds) }))
      .sort((left, right) => left.defeaterId.localeCompare(right.defeaterId)),
    policies: draft.policies
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.policyId.localeCompare(right.policyId)),
    approvals: draft.approvals
      .map((entry) => ({
        ...entry,
        acknowledgedSoftDefeaterIds: sortedUnique(entry.acknowledgedSoftDefeaterIds)
      }))
      .sort((left, right) => left.approvalId.localeCompare(right.approvalId)),
    receipts: draft.receipts
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    versions: { ...draft.versions },
    generator: { ...draft.generator }
  };
}

function bindingMaterial(value: CareerAssuranceCaseDraft | CareerAssuranceCase): object {
  const normalized = normalizeDraft({
    caseId: value.caseId,
    createdAt: value.createdAt,
    decision: value.decision,
    evidence: value.evidence,
    uncertainties: value.uncertainties,
    defeaters: value.defeaters,
    policies: value.policies,
    approvals: value.approvals,
    receipts: value.receipts,
    versions: value.versions,
    generator: value.generator
  });
  return {
    decision: normalized.decision,
    evidence: normalized.evidence,
    uncertainties: normalized.uncertainties,
    defeaters: normalized.defeaters,
    policies: normalized.policies,
    versions: normalized.versions
  };
}

export function computeAssuranceBindingHash(
  value: CareerAssuranceCaseDraft | CareerAssuranceCase
): string {
  return sha256(stableStringify(bindingMaterial(value)));
}

function caseHashMaterial(value: CareerAssuranceCase): object {
  const normalized = normalizeDraft(value);
  return {
    schemaVersion: 1,
    caseId: normalized.caseId,
    createdAt: normalized.createdAt,
    decision: normalized.decision,
    evidence: normalized.evidence,
    uncertainties: normalized.uncertainties,
    defeaters: normalized.defeaters,
    policies: normalized.policies,
    approvals: normalized.approvals,
    receipts: normalized.receipts,
    versions: normalized.versions,
    generator: normalized.generator,
    bindingHash: value.bindingHash
  };
}

export function computeAssuranceCaseHash(value: CareerAssuranceCase): string {
  return sha256(stableStringify(caseHashMaterial(value)));
}

function reason(
  code: string,
  subjectId: string,
  expected: string | null = null,
  actual: string | null = null
): AssuranceEvaluationReason {
  return { code, subjectId, expected, actual };
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function duplicateReasons<T>(
  values: readonly T[],
  id: (value: T) => string,
  code: string
): AssuranceEvaluationReason[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const current = id(value);
    if (seen.has(current)) duplicates.add(current);
    seen.add(current);
  }
  return [...duplicates].sort().map((current) => reason(code, current));
}

function invariantReasons(assuranceCase: CareerAssuranceCase): AssuranceEvaluationReason[] {
  const reasons: AssuranceEvaluationReason[] = [];
  reasons.push(...duplicateReasons(assuranceCase.evidence, (entry) => entry.evidenceId, "duplicate-evidence-id"));
  reasons.push(...duplicateReasons(assuranceCase.uncertainties, (entry) => entry.uncertaintyId, "duplicate-uncertainty-id"));
  reasons.push(...duplicateReasons(assuranceCase.defeaters, (entry) => entry.defeaterId, "duplicate-defeater-id"));
  reasons.push(...duplicateReasons(assuranceCase.policies, (entry) => entry.policyId, "duplicate-policy-id"));
  reasons.push(...duplicateReasons(assuranceCase.approvals, (entry) => entry.approvalId, "duplicate-approval-id"));
  reasons.push(...duplicateReasons(assuranceCase.receipts, (entry) => entry.receiptId, "duplicate-receipt-id"));

  const evidenceIds = new Set(assuranceCase.evidence.map((entry) => entry.evidenceId));
  const defeaters = new Map(assuranceCase.defeaters.map((entry) => [entry.defeaterId, entry]));
  const approvalIds = new Set(assuranceCase.approvals.map((entry) => entry.approvalId));
  const createdAt = timestamp(assuranceCase.createdAt);

  if (timestamp(assuranceCase.generator.generatedAt) > createdAt) {
    reasons.push(reason(
      "generator-after-case-creation",
      assuranceCase.generator.componentId,
      assuranceCase.createdAt,
      assuranceCase.generator.generatedAt
    ));
  }

  for (const evidence of assuranceCase.evidence) {
    if (timestamp(evidence.observedAt) > createdAt) {
      reasons.push(reason("evidence-observed-after-case-creation", evidence.evidenceId));
    }
    if (timestamp(evidence.freshUntil) <= timestamp(evidence.observedAt)) {
      reasons.push(reason("evidence-freshness-window-invalid", evidence.evidenceId));
    }
  }

  for (const uncertainty of assuranceCase.uncertainties) {
    for (const evidenceId of uncertainty.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        reasons.push(reason("uncertainty-evidence-missing", uncertainty.uncertaintyId, evidenceId, null));
      }
    }
  }

  for (const defeater of assuranceCase.defeaters) {
    for (const evidenceId of defeater.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        reasons.push(reason("defeater-evidence-missing", defeater.defeaterId, evidenceId, null));
      }
    }
    if (defeater.kind === "hard" && defeater.status === "accepted") {
      reasons.push(reason("hard-defeater-cannot-be-accepted", defeater.defeaterId));
    }
    if (defeater.status === "unresolved" && defeater.resolution !== null) {
      reasons.push(reason("unresolved-defeater-has-resolution", defeater.defeaterId));
    }
    if (defeater.status !== "unresolved" && defeater.resolution === null) {
      reasons.push(reason("settled-defeater-resolution-missing", defeater.defeaterId));
    }
  }

  for (const policy of assuranceCase.policies) {
    if (timestamp(policy.evaluatedAt) > createdAt) {
      reasons.push(reason("policy-evaluated-after-case-creation", policy.policyId));
    }
  }

  for (const approval of assuranceCase.approvals) {
    const approvedAt = timestamp(approval.approvedAt);
    const expiresAt = timestamp(approval.expiresAt);
    if (approval.scopeHash !== assuranceCase.bindingHash) {
      reasons.push(reason("approval-scope-mismatch", approval.approvalId, assuranceCase.bindingHash, approval.scopeHash));
    }
    if (approval.approverPrincipalId === assuranceCase.generator.principalId) {
      reasons.push(reason("approval-generator-not-separated", approval.approvalId));
    }
    if (expiresAt <= approvedAt || expiresAt - approvedAt > MAX_APPROVAL_WINDOW_MS) {
      reasons.push(reason("approval-window-invalid", approval.approvalId));
    }
    for (const defeaterId of approval.acknowledgedSoftDefeaterIds) {
      const defeater = defeaters.get(defeaterId);
      if (!defeater || defeater.kind !== "soft") {
        reasons.push(reason("approval-soft-defeater-mismatch", approval.approvalId, defeaterId, null));
      }
    }
  }

  for (const receipt of assuranceCase.receipts) {
    if (receipt.scopeHash !== assuranceCase.bindingHash) {
      reasons.push(reason("receipt-scope-mismatch", receipt.receiptId, assuranceCase.bindingHash, receipt.scopeHash));
    }
    if (receipt.approvalId !== null && !approvalIds.has(receipt.approvalId)) {
      reasons.push(reason("receipt-approval-missing", receipt.receiptId, receipt.approvalId, null));
    }
  }

  const certification = assuranceCase.certification;
  if (certification) {
    if (
      certification.certifierPrincipalId === assuranceCase.generator.principalId
      || certification.certifierComponentId === assuranceCase.generator.componentId
    ) {
      reasons.push(reason("self-certification-prohibited", assuranceCase.caseId));
    }
    if (certification.certifiedCaseHash !== assuranceCase.caseHash) {
      reasons.push(reason(
        "certification-case-hash-mismatch",
        assuranceCase.caseId,
        assuranceCase.caseHash,
        certification.certifiedCaseHash
      ));
    }
    if (timestamp(certification.certifiedAt) < createdAt) {
      reasons.push(reason("certification-before-case-creation", assuranceCase.caseId));
    }
  }
  return reasons;
}

function currentStateReasons(
  assuranceCase: CareerAssuranceCase,
  state: AssuranceCurrentState
): AssuranceEvaluationReason[] {
  const reasons: AssuranceEvaluationReason[] = [];
  for (const evidence of assuranceCase.evidence) {
    const current = state.evidence[evidence.evidenceId];
    if (!current) {
      reasons.push(reason("current-evidence-missing", evidence.evidenceId));
      continue;
    }
    if (current.claimHash !== evidence.claimHash) {
      reasons.push(reason("claim-hash-changed", evidence.evidenceId, evidence.claimHash, current.claimHash));
    }
    if (current.sourceHash !== evidence.sourceHash) {
      reasons.push(reason("source-hash-changed", evidence.evidenceId, evidence.sourceHash, current.sourceHash));
    }
  }
  for (const policy of assuranceCase.policies) {
    const current = state.policyVersions[policy.policyId];
    if (current === undefined) {
      reasons.push(reason("current-policy-missing", policy.policyId));
    } else if (current !== policy.policyVersionHash) {
      reasons.push(reason("policy-version-changed", policy.policyId, policy.policyVersionHash, current));
    }
  }
  const versionKeys: readonly (keyof AssuranceVersionHashes)[] = [
    "modelHash",
    "policySetHash",
    "taxonomyHash",
    "dataSnapshotHash",
    "generatorBuildHash"
  ];
  for (const key of versionKeys) {
    if (state.versions[key] !== assuranceCase.versions[key]) {
      reasons.push(reason("version-hash-changed", key, assuranceCase.versions[key], state.versions[key]));
    }
  }
  return reasons;
}

function activeApprovals(assuranceCase: CareerAssuranceCase, now: Date): AssuranceApproval[] {
  const current = now.getTime();
  return assuranceCase.approvals.filter((approval) => (
    approval.scopeHash === assuranceCase.bindingHash
    && approval.approverPrincipalId !== assuranceCase.generator.principalId
    && timestamp(approval.approvedAt) <= current
    && timestamp(approval.expiresAt) > current
  ));
}

function actionBlockers(assuranceCase: CareerAssuranceCase, now: Date): AssuranceEvaluationReason[] {
  const blockers: AssuranceEvaluationReason[] = [];
  if (assuranceCase.decision.recommendation !== "proceed") {
    blockers.push(reason("recommendation-not-proceed", assuranceCase.decision.decisionId, "proceed", assuranceCase.decision.recommendation));
  }
  for (const evidence of assuranceCase.evidence) {
    if (timestamp(evidence.freshUntil) <= now.getTime()) {
      blockers.push(reason("evidence-stale", evidence.evidenceId, evidence.freshUntil, now.toISOString()));
    }
  }
  for (const uncertainty of assuranceCase.uncertainties) {
    if (uncertainty.material && uncertainty.status === "unresolved") {
      blockers.push(reason("material-uncertainty-unresolved", uncertainty.uncertaintyId));
    }
  }
  for (const defeater of assuranceCase.defeaters) {
    if (defeater.kind === "hard" && defeater.status !== "resolved") {
      blockers.push(reason("hard-defeater-blocked", defeater.defeaterId));
    }
  }
  for (const policy of assuranceCase.policies) {
    if (policy.outcome === "deny") blockers.push(reason("policy-denied", policy.policyId));
  }

  const approvals = activeApprovals(assuranceCase, now);
  const requiresApproval = assuranceCase.decision.highStakes
    || assuranceCase.decision.reversibility === "R3"
    || assuranceCase.decision.reversibility === "R4"
    || assuranceCase.policies.some((policy) => policy.outcome === "manual-review");
  if (requiresApproval && approvals.length === 0) {
    blockers.push(reason("current-approval-required", assuranceCase.caseId));
  }
  const acknowledged = new Set(approvals.flatMap((approval) => approval.acknowledgedSoftDefeaterIds));
  for (const defeater of assuranceCase.defeaters) {
    if (defeater.kind === "soft" && defeater.status !== "resolved" && !acknowledged.has(defeater.defeaterId)) {
      blockers.push(reason("soft-defeater-not-acknowledged", defeater.defeaterId));
    }
  }
  return blockers;
}

function sortReasons(reasons: readonly AssuranceEvaluationReason[]): AssuranceEvaluationReason[] {
  const byKey = new Map<string, AssuranceEvaluationReason>();
  for (const current of reasons) {
    byKey.set(stableStringify(current), current);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, current]) => current);
}

export function createCareerAssuranceCase(
  draft: CareerAssuranceCaseDraft,
  operationNow = new Date()
): CareerAssuranceCase {
  if (!Number.isFinite(operationNow.getTime())) throw new Error("Assurance operation time is invalid");
  const normalized = normalizeDraft(draft);
  const bindingHash = computeAssuranceBindingHash(normalized);
  const assuranceCase: CareerAssuranceCase = {
    schemaVersion: 1,
    ...normalized,
    bindingHash,
    caseHash: sha256("pending-assurance-case-hash"),
    certification: null
  };
  assuranceCase.caseHash = computeAssuranceCaseHash(assuranceCase);
  assertAssuranceSchema("assurance-case", assuranceCase);
  const invariants = sortReasons(invariantReasons(assuranceCase));
  if (invariants.length > 0) {
    throw new Error(`Career assurance case invariants failed: ${invariants.map((entry) => entry.code).join(", ")}`);
  }
  if (
    assuranceCase.decision.recommendation === "proceed"
    && assuranceCase.defeaters.some((entry) => entry.kind === "hard" && entry.status !== "resolved")
  ) {
    throw new Error("hard-defeater-unresolved: a proceed recommendation cannot contain an unresolved hard defeater");
  }
  if (
    assuranceCase.decision.recommendation === "proceed"
    && assuranceCase.policies.some((entry) => entry.outcome === "deny")
  ) {
    throw new Error("policy-denied: a proceed recommendation cannot override a deny policy outcome");
  }
  if (assuranceCase.decision.recommendation === "proceed") {
    const creationEvaluation = evaluateCareerAssuranceCase(assuranceCase, {
      now: operationNow,
      requireCertification: false
    });
    const creationBlockerCodes = new Set([
      "evidence-stale",
      "material-uncertainty-unresolved",
      "hard-defeater-blocked",
      "policy-denied",
      "current-approval-required",
      "soft-defeater-not-acknowledged"
    ]);
    const blockers = creationEvaluation.reasons.filter((entry) => creationBlockerCodes.has(entry.code));
    if (blockers.length > 0) {
      const codes = blockers.map((entry) => (
        entry.code === "hard-defeater-blocked" ? "hard-defeater-unresolved" : entry.code
      ));
      throw new Error(`Career assurance case is blocked: ${codes.join(", ")}`);
    }
  }
  return deepFreeze(assuranceCase);
}

function malformedEvaluation(value: unknown, errors: readonly string[], now: Date): AssuranceEvaluation {
  const reasons = errors.map((error) => reason("schema-invalid", "assurance-case", null, error));
  const evaluationHash = sha256(stableStringify({
    caseHash: typeof value === "object" && value !== null && "caseHash" in value
      ? String((value as { caseHash?: unknown }).caseHash ?? "missing")
      : "missing",
    evaluatedAt: now.toISOString(),
    valid: false,
    actionable: false,
    certified: false,
    reasons
  }));
  return { valid: false, actionable: false, certified: false, reasons, evaluationHash };
}

export function evaluateCareerAssuranceCase(
  value: unknown,
  options: AssuranceEvaluationOptions = {}
): AssuranceEvaluation {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Assurance evaluation time is invalid");
  const schema = validateAssuranceSchema("assurance-case", value);
  if (!schema.valid) return malformedEvaluation(value, schema.errors, now);
  const assuranceCase = value as CareerAssuranceCase;

  const integrityReasons = invariantReasons(assuranceCase);
  const expectedBindingHash = computeAssuranceBindingHash(assuranceCase);
  if (assuranceCase.bindingHash !== expectedBindingHash) {
    integrityReasons.push(reason("binding-hash-mismatch", assuranceCase.caseId, expectedBindingHash, assuranceCase.bindingHash));
  }
  const expectedCaseHash = computeAssuranceCaseHash(assuranceCase);
  if (assuranceCase.caseHash !== expectedCaseHash) {
    integrityReasons.push(reason("case-hash-mismatch", assuranceCase.caseId, expectedCaseHash, assuranceCase.caseHash));
  }
  if (options.currentState) {
    integrityReasons.push(...currentStateReasons(assuranceCase, options.currentState));
  }
  for (const evidence of assuranceCase.evidence) {
    if (timestamp(evidence.freshUntil) <= now.getTime()) {
      integrityReasons.push(reason("evidence-stale", evidence.evidenceId, evidence.freshUntil, now.toISOString()));
    }
  }

  const certified = assuranceCase.certification !== null
    && assuranceCase.certification.certifierPrincipalId !== assuranceCase.generator.principalId
    && assuranceCase.certification.certifierComponentId !== assuranceCase.generator.componentId
    && assuranceCase.certification.certifiedCaseHash === assuranceCase.caseHash;
  const blockers = actionBlockers(assuranceCase, now);
  if (!options.currentState) {
    blockers.push(reason("current-binding-state-required", assuranceCase.caseId));
  }
  const requireCertification = options.requireCertification ?? true;
  if (requireCertification && !certified) blockers.push(reason("independent-certification-required", assuranceCase.caseId));
  const valid = integrityReasons.length === 0;
  const actionable = valid && blockers.length === 0;
  const reasons = sortReasons([...integrityReasons, ...blockers]);
  const evaluationHash = sha256(stableStringify({
    caseHash: assuranceCase.caseHash,
    evaluatedAt: now.toISOString(),
    requireCertification,
    currentState: options.currentState ?? null,
    valid,
    actionable,
    certified,
    reasons
  }));
  return { valid, actionable, certified, reasons, evaluationHash };
}

export function certifyCareerAssuranceCase(
  assuranceCase: CareerAssuranceCase,
  draft: AssuranceCertificationDraft,
  operationNow = new Date(draft.certifiedAt)
): CareerAssuranceCase {
  if (
    draft.certifierPrincipalId === assuranceCase.generator.principalId
    || draft.certifierComponentId === assuranceCase.generator.componentId
  ) {
    throw new Error("Self certification is prohibited for the assurance generator");
  }
  const certifiedAt = new Date(draft.certifiedAt);
  if (!Number.isFinite(operationNow.getTime()) || certifiedAt.getTime() > operationNow.getTime()) {
    throw new Error("Assurance certification operation time is invalid");
  }
  if (!Number.isFinite(certifiedAt.getTime()) || certifiedAt.getTime() < timestamp(assuranceCase.createdAt)) {
    throw new Error("Assurance certification time is invalid");
  }
  const beforeCertification = evaluateCareerAssuranceCase(assuranceCase, {
    now: operationNow,
    requireCertification: false
  });
  if (!beforeCertification.valid) {
    throw new Error(`Cannot certify an invalid assurance case: ${beforeCertification.reasons.map((entry) => entry.code).join(", ")}`);
  }
  const certified: CareerAssuranceCase = {
    ...assuranceCase,
    certification: {
      certifierPrincipalId: draft.certifierPrincipalId,
      certifierComponentId: draft.certifierComponentId,
      certifiedAt: draft.certifiedAt,
      certifiedCaseHash: assuranceCase.caseHash,
      signatureReceiptHash: draft.signatureReceiptHash
    }
  };
  assertAssuranceSchema("assurance-case", certified);
  const evaluation = evaluateCareerAssuranceCase(certified, { now: operationNow });
  if (!evaluation.valid || !evaluation.certified) {
    throw new Error(`Assurance certification failed: ${evaluation.reasons.map((entry) => entry.code).join(", ")}`);
  }
  return deepFreeze(certified);
}

export function assertCareerAssuranceCaseActionable(
  assuranceCase: CareerAssuranceCase,
  options: AssuranceEvaluationOptions = {}
): AssuranceEvaluation {
  const evaluation = evaluateCareerAssuranceCase(assuranceCase, options);
  if (!evaluation.actionable) {
    throw new Error(`Career assurance case is not actionable: ${evaluation.reasons.map((entry) => entry.code).join(", ")}`);
  }
  return evaluation;
}

export function assurancePolicyIndex(
  policies: readonly AssurancePolicyDecision[]
): Readonly<Record<string, string>> {
  return Object.fromEntries(policies.map((policy) => [policy.policyId, policy.policyVersionHash]));
}

export function unresolvedHardDefeaters(
  defeaters: readonly AssuranceDefeater[]
): AssuranceDefeater[] {
  return defeaters.filter((entry) => entry.kind === "hard" && entry.status !== "resolved");
}

export const evaluateAssuranceCase = evaluateCareerAssuranceCase;
