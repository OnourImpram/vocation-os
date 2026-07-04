import { scoreOpportunity, type ScoreInput } from "./rubric.js";
import { assertSchema } from "./schema.js";
import { MODE_NAMES, type HighStakesFlags, type ModeName, type ModeOutput, type ReversibilityTag, type SourceSearchOutcome } from "./types.js";

export interface ModeSpec {
  mode: ModeName;
  reversibilityTag: ReversibilityTag;
  highStakesByDefault: boolean;
}

export const MODE_SPECS: ModeSpec[] = MODE_NAMES.map((mode) => ({
  mode,
  reversibilityTag: mode === "/auto-apply-config" || mode === "/application-packet" ? "R3" : mode === "/founder-route" ? "R4" : "R0",
  highStakesByDefault:
    mode === "/phd-strategy" ||
    mode === "/fellowship-watch" ||
    mode === "/founder-route" ||
    mode === "/auto-apply-config"
}));

function hasHighStakes(flags: HighStakesFlags | undefined): boolean {
  return Object.values(flags ?? {}).some(Boolean);
}

export function specialistQuestions(flags?: HighStakesFlags): string[] {
  const questions: string[] = [];
  if (flags?.immigrationSensitive) {
    questions.push("Which immigration category applies, and which official eligibility criteria are unmet or uncertain?");
  }
  if (flags?.licensingSensitive) {
    questions.push("Which protected title or licensing pathway applies in the target jurisdiction?");
  }
  if (flags?.financialLiabilitySensitive) {
    questions.push("What financial liability, debt, equity, or contract exposure could follow from this route?");
  }
  if (flags?.clinicalOrMentalHealthSensitive) {
    questions.push("Could this decision interact with clinical vulnerability, care continuity, or mental health risk?");
  }
  if (flags?.researchIntegritySensitive) {
    questions.push("Are authorship, attribution, research integrity, or publication claims affected?");
  }
  if (flags?.conflictOfInterestSensitive) {
    questions.push("Could this route create a conflict with employment, supervision, contract, or institutional duties?");
  }
  if (flags?.publicReputationSensitive) {
    questions.push("What public disclosure, reputation, or irreversible identity signal could this create?");
  }
  if (flags?.familyRelocationSensitive) {
    questions.push("What family system, relocation, caregiving, or dependent impact requires explicit review?");
  }
  return questions;
}

export function runMode(mode: ModeName, flags?: HighStakesFlags): ModeOutput {
  const spec = MODE_SPECS.find((item) => item.mode === mode);
  if (!spec) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  const gate = spec.highStakesByDefault || hasHighStakes(flags);
  const output: ModeOutput = {
    mode,
    reversibilityTag: spec.reversibilityTag,
    humanApprovalRequired: gate || spec.reversibilityTag === "R3" || spec.reversibilityTag === "R4",
    highStakesCertaintyGate: gate,
    verificationPerformed: gate ? ["evidence-check", "certainty-gate-embedded"] : ["evidence-check"],
    specialistQuestions: gate ? specialistQuestions(flags).concat(spec.highStakesByDefault ? ["Which human specialist or accountable operator must review this route before action?"] : []) : []
  };
  assertSchema("mode-output", output);
  return output;
}

export function runDeepFit(input: ScoreInput & { highStakesFlags?: HighStakesFlags }): ModeOutput & { score: ReturnType<typeof scoreOpportunity> } {
  const score = scoreOpportunity(input);
  const gate = hasHighStakes(input.highStakesFlags);
  const output: ModeOutput & { score: ReturnType<typeof scoreOpportunity> } = {
    mode: "/deep-fit",
    reversibilityTag: "R0",
    humanApprovalRequired: gate,
    highStakesCertaintyGate: gate,
    verificationPerformed: gate ? ["evidence-check", "certainty-gate-embedded"] : ["evidence-check"],
    specialistQuestions: gate ? specialistQuestions(input.highStakesFlags) : [],
    score
  };
  assertSchema("mode-output", {
    mode: output.mode,
    reversibilityTag: output.reversibilityTag,
    humanApprovalRequired: output.humanApprovalRequired,
    highStakesCertaintyGate: output.highStakesCertaintyGate,
    verificationPerformed: output.verificationPerformed,
    specialistQuestions: output.specialistQuestions
  });
  return output;
}

export function classifySearchResult(result: { found: boolean; current?: boolean; conflicting?: boolean; failed?: boolean } | null): SourceSearchOutcome {
  if (!result) {
    return "search-not-run";
  }
  if (result.failed) {
    return "search-failed";
  }
  if (result.conflicting) {
    return "conflicting-sources";
  }
  if (result.found && result.current) {
    return "found-current-source";
  }
  return "no-current-source-found";
}
