import { describe, expect, it } from "vitest";
import { assertAnswerMemory, resolveAnswerMemory, validateAnswerMemory, type AnswerMemoryRecord } from "../../src/answer-memory.js";
import { computeClaimTextHash } from "../../src/hash.js";

const NOW = new Date("2026-07-12T06:00:00.000Z");

function answer(overrides: Partial<AnswerMemoryRecord> = {}): AnswerMemoryRecord {
  const normalizedPrompt = overrides.normalizedPrompt ?? "What is your preferred work arrangement?";
  const answerText = overrides.answerText ?? "Fully remote";
  return {
    answerId: "ANS-TEST-001",
    questionType: "custom",
    normalizedPrompt,
    promptHash: computeClaimTextHash(normalizedPrompt),
    answerText,
    answerHash: computeClaimTextHash(answerText),
    evidenceStatus: "operator_supplied",
    sourcePointer: "operator:answer-memory-test",
    scope: "global",
    roleFamily: null,
    opportunityId: null,
    sensitivity: "standard",
    reusable: true,
    requiresPerOpportunityConfirmation: false,
    allowedModes: ["assist", "supervised"],
    expiresAt: null,
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides
  };
}

describe("policy bound application answer memory", () => {
  it("resolves the most specific reusable answer", () => {
    const global = answer();
    const scoped = answer({
      answerId: "ANS-TEST-OPPORTUNITY",
      scope: "opportunity",
      opportunityId: "OPP-DEMO-001",
      answerText: "Remote within the stated applicant geography",
      answerHash: computeClaimTextHash("Remote within the stated applicant geography")
    });

    expect(resolveAnswerMemory([global, scoped], {
      questionType: "custom",
      normalizedPrompt: global.normalizedPrompt,
      roleFamily: null,
      opportunityId: "OPP-DEMO-001",
      mode: "supervised",
      now: NOW
    })).toMatchObject({ status: "resolved", answer: { answerId: scoped.answerId } });
  });

  it("requires opportunity confirmation for work authorization and blocks approved auto", () => {
    const authorization = answer({
      answerId: "ANS-WORK-AUTHORIZATION",
      questionType: "work-authorization",
      normalizedPrompt: "Are you authorized to work in this country?",
      promptHash: computeClaimTextHash("Are you authorized to work in this country?"),
      answerText: "Requires operator confirmation for this jurisdiction",
      answerHash: computeClaimTextHash("Requires operator confirmation for this jurisdiction"),
      sensitivity: "sensitive",
      requiresPerOpportunityConfirmation: true,
      allowedModes: ["assist", "supervised"]
    });

    expect(resolveAnswerMemory([authorization], {
      questionType: "work-authorization",
      normalizedPrompt: authorization.normalizedPrompt,
      roleFamily: null,
      opportunityId: "OPP-DEMO-001",
      mode: "supervised",
      now: NOW
    }).status).toBe("confirmation-required");
    expect(validateAnswerMemory({ ...authorization, allowedModes: ["approved-auto"] }).join(" "))
      .toContain("cannot be approved auto");
  });

  it("never resolves EEO answers for reuse and detects text hash tampering", () => {
    const eeo = answer({
      answerId: "ANS-EEO-001",
      questionType: "eeo-demographic",
      normalizedPrompt: "Voluntary demographic response",
      promptHash: computeClaimTextHash("Voluntary demographic response"),
      sensitivity: "restricted",
      reusable: false,
      requiresPerOpportunityConfirmation: true,
      allowedModes: ["assist"]
    });
    assertAnswerMemory(eeo);
    expect(resolveAnswerMemory([eeo], {
      questionType: "eeo-demographic",
      normalizedPrompt: eeo.normalizedPrompt,
      roleFamily: null,
      opportunityId: "OPP-DEMO-001",
      mode: "assist",
      now: NOW
    })).toMatchObject({ status: "not-found", answer: null });
    expect(validateAnswerMemory({ ...eeo, answerText: "mutated" }).join(" ")).toContain("text hash mismatch");
  });

  it("does not reuse an answer for a different prompt with the same broad question type", () => {
    const record = answer();
    expect(resolveAnswerMemory([record], {
      questionType: "custom",
      normalizedPrompt: "What salary range do you expect?",
      roleFamily: null,
      opportunityId: "OPP-DEMO-001",
      mode: "supervised",
      now: NOW
    })).toMatchObject({ status: "not-found", answer: null });
  });

  it("rejects restricted answers that are reusable or eligible for approved automation", () => {
    const restricted = answer({
      answerId: "ANS-RESTRICTED-001",
      sensitivity: "restricted",
      requiresPerOpportunityConfirmation: true,
      allowedModes: ["assist", "approved-auto"]
    });
    const reasons = validateAnswerMemory(restricted).join(" ");
    expect(reasons).toContain("cannot be reusable");
    expect(reasons).toContain("assist only");
  });
});
