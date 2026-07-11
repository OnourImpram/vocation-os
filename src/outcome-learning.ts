import { randomUUID } from "node:crypto";

export const OUTCOME_STAGES = ["discovered", "shortlisted", "applied", "screen", "interview", "offer", "accepted", "rejected", "withdrawn"] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];

export interface CareerOutcomeEvent {
  outcomeId: string;
  opportunityId: string;
  stage: OutcomeStage;
  occurredAt: string;
  source: "operator" | "ats-receipt" | "email-receipt" | "platform";
  modelVersion: string;
  policyVersion: string;
  documentVariantId: string | null;
  messageVariantId: string | null;
  evidencePointer: string;
}

export interface SequentialExperiment {
  experimentId: string;
  hypothesis: string;
  changedVariable: "document" | "message" | "targeting" | "timing";
  baselineVariantId: string;
  candidateVariantId: string;
  approvalId: string;
  startedAt: string;
  status: "active" | "stopped" | "completed" | "rolled-back";
}

export function createOutcomeEvent(input: Omit<CareerOutcomeEvent, "outcomeId">): CareerOutcomeEvent {
  if (!input.evidencePointer.trim()) throw new Error("Outcome evidence pointer is required");
  if (!input.modelVersion.trim() || !input.policyVersion.trim()) throw new Error("Outcome model and policy versions are required");
  return { ...input, outcomeId: `OUT-${randomUUID()}` };
}

export function registerSequentialExperiment(
  input: Omit<SequentialExperiment, "experimentId" | "status">
): SequentialExperiment {
  if (!input.approvalId.startsWith("APR-")) throw new Error("Sequential experiments require an explicit approval id");
  if (input.baselineVariantId === input.candidateVariantId) throw new Error("Experiment variants must differ");
  return { ...input, experimentId: `EXP-${randomUUID()}`, status: "active" };
}

export function outcomeFunnel(events: CareerOutcomeEvent[]): Record<OutcomeStage, number> {
  const unique = new Map<string, Set<OutcomeStage>>();
  for (const event of events) {
    const stages = unique.get(event.opportunityId) ?? new Set<OutcomeStage>();
    stages.add(event.stage);
    unique.set(event.opportunityId, stages);
  }
  return Object.fromEntries(
    OUTCOME_STAGES.map((stage) => [stage, [...unique.values()].filter((stages) => stages.has(stage)).length])
  ) as Record<OutcomeStage, number>;
}
