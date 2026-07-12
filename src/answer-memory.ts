import { computeClaimTextHash } from "./hash.js";
import { assertSchema } from "./schema.js";
import type { EvidenceStatus } from "./types.js";

export const ANSWER_QUESTION_TYPES = [
  "identity",
  "contact",
  "work-authorization",
  "visa-sponsorship",
  "relocation",
  "compensation",
  "license",
  "education",
  "experience",
  "skill",
  "eeo-demographic",
  "custom"
] as const;

export type AnswerQuestionType = (typeof ANSWER_QUESTION_TYPES)[number];
export type AnswerUseMode = "assist" | "supervised" | "approved-auto";
export type AnswerScope = "global" | "role-family" | "opportunity";

export interface AnswerMemoryRecord {
  answerId: string;
  questionType: AnswerQuestionType;
  normalizedPrompt: string;
  promptHash: string;
  answerText: string;
  answerHash: string;
  evidenceStatus: Extract<EvidenceStatus, "verified" | "operator_supplied">;
  sourcePointer: string;
  scope: AnswerScope;
  roleFamily: string | null;
  opportunityId: string | null;
  sensitivity: "standard" | "sensitive" | "restricted";
  reusable: boolean;
  requiresPerOpportunityConfirmation: boolean;
  allowedModes: AnswerUseMode[];
  expiresAt: string | null;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}

export interface AnswerResolutionContext {
  questionType: AnswerQuestionType;
  roleFamily: string | null;
  opportunityId: string;
  mode: AnswerUseMode;
  now: Date;
}

export interface AnswerResolution {
  status: "resolved" | "confirmation-required" | "not-found";
  answer: AnswerMemoryRecord | null;
  reasons: string[];
}

const HIGH_STAKES_QUESTION_TYPES = new Set<AnswerQuestionType>([
  "work-authorization",
  "visa-sponsorship",
  "relocation",
  "compensation",
  "license"
]);

export function validateAnswerMemory(record: AnswerMemoryRecord): string[] {
  try {
    assertSchema("answer-memory-record", record);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const reasons: string[] = [];
  if (record.promptHash !== computeClaimTextHash(record.normalizedPrompt)) reasons.push("answer prompt hash mismatch");
  if (record.answerHash !== computeClaimTextHash(record.answerText)) reasons.push("answer text hash mismatch");
  if (record.scope === "opportunity" && record.opportunityId === null) reasons.push("opportunity scoped answer is missing opportunity id");
  if (record.scope === "role-family" && record.roleFamily === null) reasons.push("role family scoped answer is missing role family");
  if (record.questionType === "eeo-demographic") {
    if (record.reusable) reasons.push("EEO answers cannot be reusable");
    if (!record.requiresPerOpportunityConfirmation) reasons.push("EEO answers require per opportunity confirmation");
    if (record.allowedModes.some((mode) => mode !== "assist")) reasons.push("EEO answers are assist only");
  }
  if (HIGH_STAKES_QUESTION_TYPES.has(record.questionType)) {
    if (!record.requiresPerOpportunityConfirmation) reasons.push("high stakes answers require per opportunity confirmation");
    if (record.allowedModes.includes("approved-auto")) reasons.push("high stakes answers cannot be approved auto");
  }
  return reasons;
}

export function assertAnswerMemory(record: AnswerMemoryRecord): void {
  const reasons = validateAnswerMemory(record);
  if (reasons.length > 0) throw new Error(`Answer memory validation failed: ${reasons.join("; ")}`);
}

function scopeRank(record: AnswerMemoryRecord, context: AnswerResolutionContext): number {
  if (record.scope === "opportunity") return record.opportunityId === context.opportunityId ? 3 : -1;
  if (record.scope === "role-family") return record.roleFamily !== null && record.roleFamily === context.roleFamily ? 2 : -1;
  return 1;
}

export function resolveAnswerMemory(
  records: readonly AnswerMemoryRecord[],
  context: AnswerResolutionContext
): AnswerResolution {
  const candidates = records
    .filter((record) => {
      assertAnswerMemory(record);
      return record.status === "active"
        && record.questionType === context.questionType
        && record.allowedModes.includes(context.mode)
        && (record.expiresAt === null || Date.parse(record.expiresAt) > context.now.getTime())
        && scopeRank(record, context) > 0;
    })
    .sort((left, right) => scopeRank(right, context) - scopeRank(left, context));
  const answer = candidates[0] ?? null;
  if (!answer || !answer.reusable || answer.questionType === "eeo-demographic") {
    return { status: "not-found", answer: null, reasons: ["no reusable answer matched the requested scope and mode"] };
  }
  if (answer.requiresPerOpportunityConfirmation) {
    return { status: "confirmation-required", answer, reasons: ["answer requires confirmation for this opportunity"] };
  }
  return { status: "resolved", answer, reasons: [] };
}
