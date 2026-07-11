import { randomUUID } from "node:crypto";
import { runMode } from "./modes.js";
import { assertSchema } from "./schema.js";
import type { ActionLedgerEntry, HighStakesFlags, ModeOutput } from "./types.js";

export const PHT_SKILLS = ["curiosity", "persistence", "flexibility", "optimism", "risk-taking"] as const;

export type PhtSkill = (typeof PHT_SKILLS)[number];

export interface SkillRating {
  skill: PhtSkill;
  rating: 0 | 1 | 2 | 3 | 4;
}

export interface CoachingPractice {
  skill: PhtSkill;
  actProcess: string;
  microPractice: string;
  reflectionPrompt: string;
  reversibilityTag: "R0";
}

export interface CoachingPlan {
  planId: string;
  mode: "/skill-coach";
  reversibilityTag: "R0";
  generatedAt: string;
  disclaimer: string;
  focusSkills: PhtSkill[];
  practices: CoachingPractice[];
  journalPrompts: string[];
  sourceTheories: string[];
  referralNote?: string;
}

export const COACHING_DISCLAIMER =
  "Psychoeducational self coaching content grounded in planned happenstance skills and acceptance and commitment processes. Not clinical assessment, diagnosis, or treatment. If clinical or mental health risk is present, involve a qualified professional.";

export const CLINICAL_REFERRAL_NOTE =
  "A clinical or mental health sensitivity flag is active. This plan pauses at psychoeducation and the next step is review with a qualified mental health professional, not further automation.";

interface PracticeTemplate {
  actProcess: string;
  microPractice: string;
  reflectionPrompt: string;
}

const PRACTICE_LIBRARY: Record<PhtSkill, PracticeTemplate> = {
  curiosity: {
    actProcess: "present moment contact and openness",
    microPractice: "Pick one unfamiliar corner of your field and spend fifteen minutes reading about it, with no output required.",
    reflectionPrompt: "What did you notice that you were not looking for, and what small question did it leave behind?"
  },
  persistence: {
    actProcess: "committed action in the presence of discomfort",
    microPractice: "Return once to a stalled task for twenty minutes, defining in advance what a good enough stopping point looks like.",
    reflectionPrompt: "What showed up, thought or feeling, at the moment you most wanted to stop, and what did you do next?"
  },
  flexibility: {
    actProcess: "cognitive defusion from fixed plans",
    microPractice: "Write your current plan in one sentence, then write two genuinely different routes to the same underlying value.",
    reflectionPrompt: "Which part of the original plan turned out to be a preference wearing the costume of a requirement?"
  },
  optimism: {
    actProcess: "defusion from catastrophic prediction plus values contact",
    microPractice: "Take one worry about the transition, write the catastrophic version, then write the evidence grounded version next to it.",
    reflectionPrompt: "Where did the two versions differ, and which verified facts does the grounded version rest on?"
  },
  "risk-taking": {
    actProcess: "acceptance of uncertainty with graded committed action",
    microPractice: "Choose one bounded, reversible probe, an R0 to R2 action such as a question, a draft, or a short conversation, and schedule it.",
    reflectionPrompt: "The probe was reversible by design. What information did it buy, and what would you now be willing to try next?"
  }
};

const SOURCE_THEORY_IDS = ["PHT", "ACT", "CCT"];

export interface CoachingInput {
  ratings: SkillRating[];
  highStakesFlags?: HighStakesFlags;
  now?: Date;
}

function validateRatings(ratings: SkillRating[]): void {
  if (ratings.length !== PHT_SKILLS.length) {
    throw new Error(`Expected ${PHT_SKILLS.length} skill ratings`);
  }
  const seen = new Set<PhtSkill>();
  for (const rating of ratings) {
    if (!PHT_SKILLS.includes(rating.skill)) {
      throw new Error(`Unknown skill: ${rating.skill}`);
    }
    if (seen.has(rating.skill)) {
      throw new Error(`Duplicate skill rating: ${rating.skill}`);
    }
    seen.add(rating.skill);
    if (rating.rating < 0 || rating.rating > 4 || !Number.isInteger(rating.rating)) {
      throw new Error(`Rating out of range for ${rating.skill}`);
    }
  }
}

function skillOrder(skill: PhtSkill): number {
  return PHT_SKILLS.indexOf(skill);
}

export function buildCoachingPlan(input: CoachingInput): { plan: CoachingPlan; gate: ModeOutput } {
  validateRatings(input.ratings);
  const now = input.now ?? new Date();
  const gate = runMode("/skill-coach", input.highStakesFlags);

  const sorted = [...input.ratings].sort((a, b) => {
    if (a.rating !== b.rating) {
      return a.rating - b.rating;
    }
    return skillOrder(a.skill) - skillOrder(b.skill);
  });

  const lowest = sorted.filter((rating) => rating.rating <= 2).slice(0, 3);
  const focus = lowest.length > 0 ? lowest : sorted.slice(0, 1);
  const focusSkills = focus.map((rating) => rating.skill);

  const practices: CoachingPractice[] = focusSkills.map((skill) => {
    const template = PRACTICE_LIBRARY[skill];
    return {
      skill,
      actProcess: template.actProcess,
      microPractice: template.microPractice,
      reflectionPrompt: template.reflectionPrompt,
      reversibilityTag: "R0"
    };
  });

  const journalPrompts = [
    "Name one unplanned event from this week that touched your work life, however small.",
    "What did you do, or could you have done, to keep that door open a little longer?",
    "Which of the five skills did that response use, and which one was missing?"
  ];

  const clinicalFlag = input.highStakesFlags?.clinicalOrMentalHealthSensitive === true;

  const basePlan: CoachingPlan = {
    planId: `CP-${now.getUTCFullYear()}-${randomUUID()}`,
    mode: "/skill-coach",
    reversibilityTag: "R0",
    generatedAt: now.toISOString(),
    disclaimer: COACHING_DISCLAIMER,
    focusSkills,
    practices,
    journalPrompts,
    sourceTheories: SOURCE_THEORY_IDS
  };

  const plan: CoachingPlan = clinicalFlag ? { ...basePlan, referralNote: CLINICAL_REFERRAL_NOTE } : basePlan;

  assertSchema("coaching-plan", plan);
  return { plan, gate };
}

export function happenstanceReview(entries: ActionLedgerEntry[], limit = 5): string[] {
  const prompts: string[] = [];
  const blocked = entries.filter((entry) => entry.result === "blocked");
  const consequential = entries.filter((entry) => entry.result === "submitted" || entry.result === "confirmed");
  const drafts = entries.filter((entry) => entry.result === "draft_generated");

  if (blocked.length > 0) {
    prompts.push(
      `The ledger shows ${blocked.length} blocked action${blocked.length === 1 ? "" : "s"}. A block is information, not failure. What did the gate protect, and what evidence would honestly change the decision?`
    );
  }
  if (consequential.length > 0) {
    prompts.push(
      `You completed ${consequential.length} consequential action${consequential.length === 1 ? "" : "s"}. Which unplanned event along the way helped, and did you notice it at the time?`
    );
  }
  if (drafts.length > 0) {
    prompts.push(
      `There are ${drafts.length} draft stage action${drafts.length === 1 ? "" : "s"} in the record. Which draft is quietly waiting for a bounded, reversible probe rather than more polishing?`
    );
  }
  if (entries.length === 0) {
    prompts.push("The ledger is empty. What is one R0 exploration you could log this week, with no commitment attached?");
  }

  prompts.push("Looking at the week as a whole, where did flexibility serve you, and where did persistence?");
  return prompts.slice(0, limit);
}

