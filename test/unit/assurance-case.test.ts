import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/hash.js";
import {
  assertCareerAssuranceCaseActionable,
  assurancePolicyIndex,
  certifyCareerAssuranceCase,
  computeAssuranceBindingHash,
  createCareerAssuranceCase,
  evaluateAssuranceCase,
  renderAssuranceCaseJson,
  renderAssuranceCaseMarkdown,
  toAssuranceDocumentAst,
  unresolvedHardDefeaters,
  validateAssuranceSchemaFiles,
  type AssuranceCurrentState,
  type CareerAssuranceCase,
  type CareerAssuranceCaseDraft
} from "../../src/assurance/index.js";

const NOW = new Date("2026-07-14T12:30:00.000Z");

function hash(label: string): string {
  return sha256(label);
}

function unsignedDraft(
  overrides: Partial<CareerAssuranceCaseDraft> = {}
): CareerAssuranceCaseDraft {
  return {
    caseId: "CASE-001",
    createdAt: "2026-07-14T12:00:00.000Z",
    decision: {
      decisionId: "DECISION-001",
      routeId: "ROUTE-001",
      recommendation: "proceed",
      statement: "Proceed with the reviewed route under the bound policy and evidence set.",
      reversibility: "R2",
      highStakes: true,
      disclosure: "public"
    },
    evidence: [
      {
        evidenceId: "EVIDENCE-001",
        claimId: "CLAIM-001",
        claimHash: hash("claim-v1"),
        sourceId: "vault://private/source-001",
        sourceHash: hash("source-v1"),
        observedAt: "2026-07-14T11:00:00.000Z",
        freshUntil: "2026-07-15T11:00:00.000Z",
        disclosure: "private"
      }
    ],
    uncertainties: [
      {
        uncertaintyId: "UNCERTAINTY-001",
        description: "A non-material scheduling detail remains unresolved.",
        material: false,
        status: "unresolved",
        evidenceIds: ["EVIDENCE-001"],
        disclosure: "private"
      }
    ],
    defeaters: [
      {
        defeaterId: "DEFEATER-SOFT-001",
        kind: "soft",
        description: "The route consumes a limited amount of option value.",
        status: "accepted",
        evidenceIds: ["EVIDENCE-001"],
        resolution: "Risk accepted within the approval scope.",
        disclosure: "public"
      }
    ],
    policies: [
      {
        policyId: "POLICY-REVERSIBILITY",
        policyVersionHash: hash("policy-v1"),
        outcome: "manual-review",
        rationale: "Human review is required for an R2 high stakes recommendation.",
        evaluatedAt: "2026-07-14T12:00:00.000Z",
        disclosure: "public"
      }
    ],
    approvals: [],
    receipts: [],
    versions: {
      modelHash: hash("model-v1"),
      policySetHash: hash("policy-set-v1"),
      taxonomyHash: hash("taxonomy-v1"),
      dataSnapshotHash: hash("data-v1"),
      generatorBuildHash: hash("generator-v1")
    },
    generator: {
      principalId: "GENERATOR-PRINCIPAL",
      componentId: "assurance-generator",
      generatedAt: "2026-07-14T12:00:00.000Z"
    },
    ...overrides
  };
}

function approvedDraft(overrides: Partial<CareerAssuranceCaseDraft> = {}): CareerAssuranceCaseDraft {
  const draft = unsignedDraft(overrides);
  const scopeHash = computeAssuranceBindingHash(draft);
  return {
    ...draft,
    approvals: [
      {
        approvalId: "APPROVAL-001",
        approverPrincipalId: "HUMAN-APPROVER",
        approvedAt: "2026-07-14T12:05:00.000Z",
        expiresAt: "2026-07-14T14:00:00.000Z",
        scopeHash,
        acknowledgedSoftDefeaterIds: draft.defeaters
          .filter((item) => item.kind === "soft" && item.status !== "resolved")
          .map((item) => item.defeaterId),
        signatureReceiptHash: hash("approval-signature")
      }
    ],
    receipts: [
      {
        receiptId: "RECEIPT-001",
        operation: "route-authorization",
        outcome: "succeeded",
        occurredAt: "2026-07-14T12:10:00.000Z",
        requestHash: hash("request"),
        resultHash: hash("result"),
        eventHash: hash("event"),
        scopeHash,
        approvalId: "APPROVAL-001"
      }
    ]
  };
}

function certifiedCase(
  overrides: Partial<CareerAssuranceCaseDraft> = {},
  operationNow = NOW
): CareerAssuranceCase {
  const assuranceCase = createCareerAssuranceCase(approvedDraft(overrides), operationNow);
  return certifyCareerAssuranceCase(
    assuranceCase,
    {
      certifierPrincipalId: "INDEPENDENT-CERTIFIER",
      certifierComponentId: "independent-assurance-reviewer",
      certifiedAt: "2026-07-14T12:20:00.000Z",
      signatureReceiptHash: hash("certification-signature")
    },
    operationNow
  );
}

function currentState(assuranceCase: CareerAssuranceCase): AssuranceCurrentState {
  return {
    evidence: Object.fromEntries(
      assuranceCase.evidence.map((item) => [
        item.evidenceId,
        { claimHash: item.claimHash, sourceHash: item.sourceHash }
      ])
    ),
    policyVersions: Object.fromEntries(
      assuranceCase.policies.map((item) => [item.policyId, item.policyVersionHash])
    ),
    versions: { ...assuranceCase.versions }
  };
}

function schemaValidator(fileName: string): ReturnType<Ajv["compile"]> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const addFormats = addFormatsModule.default as unknown as (instance: Ajv) => void;
  addFormats(ajv);
  const schema = JSON.parse(
    readFileSync(path.resolve("schemas", fileName), "utf8")
  ) as AnySchema;
  return ajv.compile(schema);
}

describe("Career Assurance Case", () => {
  it("binds authority records, certifies independently, and renders schema-valid outputs", () => {
    const assuranceCase = certifiedCase();
    const evaluation = evaluateAssuranceCase(assuranceCase, {
      currentState: currentState(assuranceCase),
      now: NOW
    });

    expect(evaluation).toMatchObject({ valid: true, actionable: true, certified: true, reasons: [] });
    expect(Object.isFrozen(assuranceCase)).toBe(true);
    expect(schemaValidator("assurance-case.schema.json")(assuranceCase)).toBe(true);

    const json = renderAssuranceCaseJson(assuranceCase, evaluation);
    const markdown = renderAssuranceCaseMarkdown(assuranceCase, evaluation);
    const documentAst = toAssuranceDocumentAst(assuranceCase, evaluation);

    expect(json).not.toContain("vault://private/source-001");
    expect(json).not.toContain("scheduling detail remains unresolved");
    expect(json).toContain("[redacted]");
    expect(markdown).toContain("VALID AND ACTIONABLE");
    expect(markdown).not.toContain("vault://private/source-001");
    expect(schemaValidator("assurance-document-ast.schema.json")(documentAst)).toBe(true);
  });

  it("invalidates stale evidence deterministically", () => {
    const assuranceCase = certifiedCase(
      {
        evidence: [
          {
            ...unsignedDraft().evidence[0]!,
            freshUntil: "2026-07-14T12:29:59.000Z"
          }
        ]
      },
      new Date("2026-07-14T12:25:00.000Z")
    );
    const first = evaluateAssuranceCase(assuranceCase, {
      currentState: currentState(assuranceCase),
      now: NOW
    });
    const second = evaluateAssuranceCase(assuranceCase, {
      currentState: currentState(assuranceCase),
      now: NOW
    });

    expect(first.valid).toBe(false);
    expect(first.actionable).toBe(false);
    expect(first.reasons.map((item) => item.code)).toContain("evidence-stale");
    expect(second).toEqual(first);
  });

  it("does not leak private narratives through Markdown or DocumentAST", () => {
    const draft = unsignedDraft();
    const assuranceCase = certifiedCase({
      decision: {
        ...draft.decision,
        statement: "PRIVATE DECISION NARRATIVE",
        disclosure: "private"
      },
      policies: [{
        ...draft.policies[0]!,
        rationale: "PRIVATE POLICY NARRATIVE",
        disclosure: "private"
      }]
    });
    const evaluation = evaluateAssuranceCase(assuranceCase, {
      currentState: currentState(assuranceCase),
      now: NOW
    });
    const markdown = renderAssuranceCaseMarkdown(assuranceCase, evaluation);
    const documentAst = toAssuranceDocumentAst(assuranceCase, evaluation);
    const astJson = JSON.stringify(documentAst);

    expect(markdown).not.toContain("PRIVATE DECISION NARRATIVE");
    expect(markdown).not.toContain("PRIVATE POLICY NARRATIVE");
    expect(astJson).not.toContain("PRIVATE DECISION NARRATIVE");
    expect(astJson).not.toContain("PRIVATE POLICY NARRATIVE");
    expect(documentAst.metadata.redactedNarrativeCount).toBe(3);
  });

  it("invalidates changed claims, sources, policies, and version sets", () => {
    const assuranceCase = certifiedCase();
    const state = currentState(assuranceCase);
    const changed: AssuranceCurrentState = {
      evidence: {
        "EVIDENCE-001": {
          claimHash: hash("claim-v2"),
          sourceHash: hash("source-v2")
        }
      },
      policyVersions: {
        "POLICY-REVERSIBILITY": hash("policy-v2")
      },
      versions: {
        ...state.versions,
        taxonomyHash: hash("taxonomy-v2")
      }
    };

    const evaluation = evaluateAssuranceCase(assuranceCase, { currentState: changed, now: NOW });
    const codes = evaluation.reasons.map((item) => item.code);
    expect(evaluation.valid).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        "claim-hash-changed",
        "source-hash-changed",
        "policy-version-changed",
        "version-hash-changed"
      ])
    );
  });

  it("does not claim actionability without a current binding state", () => {
    const assuranceCase = certifiedCase();
    const evaluation = evaluateAssuranceCase(assuranceCase, { now: NOW });

    expect(evaluation.valid).toBe(true);
    expect(evaluation.actionable).toBe(false);
    expect(evaluation.reasons.map((item) => item.code)).toContain("current-binding-state-required");
  });

  it("blocks unresolved hard defeaters and unacknowledged soft defeaters", () => {
    const hardDraft = unsignedDraft({
      defeaters: [
        {
          defeaterId: "DEFEATER-HARD-001",
          kind: "hard",
          description: "Required authorization is absent.",
          status: "unresolved",
          evidenceIds: ["EVIDENCE-001"],
          resolution: null,
          disclosure: "public"
        }
      ]
    });
    expect(() => createCareerAssuranceCase(approvedDraft(hardDraft), NOW)).toThrow("hard-defeater-unresolved");

    const softDraft = approvedDraft();
    const unacknowledged = {
      ...softDraft,
      approvals: softDraft.approvals.map((approval) => ({
        ...approval,
        acknowledgedSoftDefeaterIds: []
      }))
    };
    expect(() => createCareerAssuranceCase(unacknowledged, NOW)).toThrow("soft-defeater-not-acknowledged");
  });

  it("prevents a generator from certifying its own case", () => {
    const assuranceCase = createCareerAssuranceCase(approvedDraft(), NOW);
    expect(() =>
      certifyCareerAssuranceCase(
        assuranceCase,
        {
          certifierPrincipalId: assuranceCase.generator.principalId,
          certifierComponentId: "nominally-separate-component",
          certifiedAt: "2026-07-14T12:20:00.000Z",
          signatureReceiptHash: hash("self-certification")
        },
        NOW
      )
    ).toThrow("Self certification is prohibited");

    const forged: CareerAssuranceCase = {
      ...assuranceCase,
      certification: {
        certifierPrincipalId: assuranceCase.generator.principalId,
        certifierComponentId: "nominally-separate-component",
        certifiedAt: "2026-07-14T12:20:00.000Z",
        certifiedCaseHash: assuranceCase.caseHash,
        signatureReceiptHash: hash("self-certification")
      }
    };
    expect(evaluateAssuranceCase(forged, { now: NOW }).reasons.map((item) => item.code)).toContain(
      "self-certification-prohibited"
    );
  });

  it("fails closed for malformed and content-tampered assurance records", () => {
    const malformed = evaluateAssuranceCase({ caseHash: "not-a-hash" }, { now: NOW });
    expect(malformed).toMatchObject({ valid: false, actionable: false, certified: false });
    expect(malformed.reasons.every((item) => item.code === "schema-invalid")).toBe(true);

    const assuranceCase = certifiedCase();
    const tampered: CareerAssuranceCase = {
      ...assuranceCase,
      decision: {
        ...assuranceCase.decision,
        statement: "A changed recommendation narrative."
      }
    };
    const evaluation = evaluateAssuranceCase(tampered, { now: NOW });
    expect(evaluation.valid).toBe(false);
    expect(evaluation.reasons.map((item) => item.code)).toEqual(
      expect.arrayContaining(["binding-hash-mismatch", "case-hash-mismatch"])
    );
  });

  it("keeps an intact but expired approval case valid and non-actionable", () => {
    const assuranceCase = certifiedCase();
    const evaluation = evaluateAssuranceCase(assuranceCase, {
      now: new Date("2026-07-14T14:00:00.000Z")
    });
    expect(evaluation.valid).toBe(true);
    expect(evaluation.actionable).toBe(false);
    expect(evaluation.reasons.map((item) => item.code)).toContain("current-approval-required");
  });

  it("exposes actionable, policy, defeater, schema, and private render contracts", () => {
    const assuranceCase = certifiedCase();
    const evaluation = assertCareerAssuranceCaseActionable(assuranceCase, {
      now: NOW,
      currentState: currentState(assuranceCase)
    });
    expect(evaluation.actionable).toBe(true);
    expect(assurancePolicyIndex(assuranceCase.policies)).toEqual({
      "POLICY-REVERSIBILITY": hash("policy-v1")
    });
    expect(unresolvedHardDefeaters(assuranceCase.defeaters)).toEqual([]);
    expect(validateAssuranceSchemaFiles()).toEqual({ valid: true, errors: [] });

    const options = { includePrivateEvidence: true } as const;
    expect(renderAssuranceCaseJson(assuranceCase, evaluation, options)).toContain("vault://private/source-001");
    expect(renderAssuranceCaseMarkdown(assuranceCase, evaluation, options)).toContain("vault://private/source-001");
    expect(toAssuranceDocumentAst(assuranceCase, evaluation, options).metadata.redactedEvidenceCount).toBe(0);
  });
});
