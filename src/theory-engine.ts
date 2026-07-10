import { THEORY_REGISTRY, getTheoryLens, type TheoryLens } from "./theory.js";
import type { HighStakesFlags, ModeName, ReversibilityTag } from "./types.js";
import { specialistQuestions } from "./modes.js";

export function lensesForMode(mode: ModeName): TheoryLens[] {
  return THEORY_REGISTRY
    .filter((lens) => lens.modeBindings.includes(mode))
    .sort((a, b) => a.theoryId.localeCompare(b.theoryId));
}

export interface TheoryQuestionOptions {
  limit?: number;
  highStakesFlags?: HighStakesFlags;
}

export function questionsForMode(mode: ModeName, options: TheoryQuestionOptions = {}): string[] {
  const limit = options.limit ?? 6;
  const collected: string[] = [];
  const seen = new Set<string>();

  for (const question of specialistQuestions(options.highStakesFlags)) {
    if (!seen.has(question)) {
      seen.add(question);
      collected.push(question);
    }
  }

  for (const lens of lensesForMode(mode)) {
    for (const question of lens.decisionQuestions) {
      if (!seen.has(question)) {
        seen.add(question);
        collected.push(question);
      }
    }
  }

  return collected.slice(0, limit);
}

export function optionValueNote(tag: ReversibilityTag): string {
  const notes: Record<ReversibilityTag, string> = {
    R0: "Draft stage. Waiting costs nothing here, so explore widely before narrowing.",
    R1: "Local reversible edit. Iteration is cheap, so prefer many small revisions over one large leap.",
    R2: "External but low consequence. A bounded probe that buys information at low option cost.",
    R3: "External consequential action. Commitment consumes option value, so confirm the information gained by waiting is truly exhausted.",
    R4: "Irreversible or high consequence. Under uncertainty, irreversible commitment destroys option value, which is why R4 never auto submits."
  };
  return notes[tag];
}

export type DifficultyCluster = "lack-of-readiness" | "lack-of-information" | "inconsistent-information";

export interface DecisionDifficultyInput {
  lowMotivation?: boolean;
  generalIndecisiveness?: boolean;
  dysfunctionalBeliefs?: boolean;
  missingProcessKnowledge?: boolean;
  missingSelfKnowledge?: boolean;
  missingOccupationKnowledge?: boolean;
  missingInformationSources?: boolean;
  unreliableInformation?: boolean;
  internalConflicts?: boolean;
  externalConflicts?: boolean;
}

export interface DifficultyClusterProfile {
  cluster: DifficultyCluster;
  flags: string[];
  recommendedModes: ModeName[];
  theoryIds: string[];
  note: string;
}

export interface DifficultyProfile {
  clusters: DifficultyClusterProfile[];
  primaryCluster: DifficultyCluster | null;
  recommendedNextModes: ModeName[];
}

interface ClusterSpec {
  cluster: DifficultyCluster;
  keys: Array<keyof DecisionDifficultyInput>;
  recommendedModes: ModeName[];
  theoryIds: string[];
  note: string;
}

const CLUSTER_SPECS: ClusterSpec[] = [
  {
    cluster: "lack-of-readiness",
    keys: ["lowMotivation", "generalIndecisiveness", "dysfunctionalBeliefs"],
    recommendedModes: ["/skill-coach", "/decision-intake"],
    theoryIds: ["CDDQ", "PHT", "ACT"],
    note: "Readiness difficulties respond to skill and flexibility work before any information campaign."
  },
  {
    cluster: "lack-of-information",
    keys: ["missingProcessKnowledge", "missingSelfKnowledge", "missingOccupationKnowledge", "missingInformationSources"],
    recommendedModes: ["/profile-audit", "/opportunity-ingest", "/evidence-gap"],
    theoryIds: ["CDDQ", "SCCT", "PEFIT"],
    note: "Information difficulties call for structured evidence gathering with explicit source status."
  },
  {
    cluster: "inconsistent-information",
    keys: ["unreliableInformation", "internalConflicts", "externalConflicts"],
    recommendedModes: ["/evidence-gap", "/steelman", "/risk-register"],
    theoryIds: ["CDDQ", "DECISION", "ROLECONF"],
    note: "Conflicting information calls for source triage, multi route steelman review, and named conflict handling."
  }
];

export function classifyDecisionDifficulties(input: DecisionDifficultyInput): DifficultyProfile {
  const clusters: DifficultyClusterProfile[] = [];

  for (const spec of CLUSTER_SPECS) {
    const flags = spec.keys.filter((key) => input[key] === true).map((key) => String(key));
    if (flags.length > 0) {
      clusters.push({
        cluster: spec.cluster,
        flags,
        recommendedModes: spec.recommendedModes,
        theoryIds: spec.theoryIds,
        note: spec.note
      });
    }
  }

  const primary = clusters.reduce<DifficultyClusterProfile | null>((best, current) => {
    if (best === null || current.flags.length > best.flags.length) {
      return current;
    }
    return best;
  }, null);

  const recommendedNextModes: ModeName[] = [];
  for (const cluster of clusters) {
    for (const mode of cluster.recommendedModes) {
      if (!recommendedNextModes.includes(mode)) {
        recommendedNextModes.push(mode);
      }
    }
  }

  return {
    clusters,
    primaryCluster: primary ? primary.cluster : null,
    recommendedNextModes
  };
}

export interface TheoryBrief {
  mode: ModeName;
  lenses: Array<{ theoryId: string; name: string; coreConstructs: string[] }>;
  questions: string[];
  rubricFocus: string[];
  reversibilityGuidance: string;
}

export function composeTheoryBrief(mode: ModeName, tag: ReversibilityTag, flags?: HighStakesFlags): TheoryBrief {
  const lenses = lensesForMode(mode);
  const rubricFocus: string[] = [];
  for (const lens of lenses) {
    for (const dimension of lens.rubricBindings) {
      if (!rubricFocus.includes(dimension)) {
        rubricFocus.push(dimension);
      }
    }
  }
  rubricFocus.sort();

  const questionOptions: TheoryQuestionOptions = flags === undefined ? {} : { highStakesFlags: flags };

  return {
    mode,
    lenses: lenses.map((lens) => ({
      theoryId: lens.theoryId,
      name: lens.name,
      coreConstructs: lens.coreConstructs
    })),
    questions: questionsForMode(mode, questionOptions),
    rubricFocus,
    reversibilityGuidance: optionValueNote(tag)
  };
}

export function describeTheory(theoryId: string): string {
  const lens = getTheoryLens(theoryId);
  if (!lens) {
    return `Unknown theory id: ${theoryId}`;
  }
  const primary = lens.citations[0];
  const citationText = primary ? `${primary.authors} (${primary.year})` : "no citation";
  return `${lens.name} [${lens.family}] constructs: ${lens.coreConstructs.join(", ")}. Primary source: ${citationText}.`;
}
