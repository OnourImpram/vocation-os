import type { ReversibilityTag } from "./types.js";

export function isAutoSubmittable(tag: ReversibilityTag): boolean {
  return tag !== "R4";
}

export function requiresHumanApproval(tag: ReversibilityTag): boolean {
  return tag === "R2" || tag === "R3" || tag === "R4";
}

export function describeReversibility(tag: ReversibilityTag): string {
  const descriptions: Record<ReversibilityTag, string> = {
    R0: "internal reasoning or draft only",
    R1: "local reversible edit",
    R2: "external but low consequence action",
    R3: "external consequential action",
    R4: "irreversible or high consequence action"
  };
  return descriptions[tag];
}
