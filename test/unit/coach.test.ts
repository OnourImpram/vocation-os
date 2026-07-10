import { describe, expect, it } from "vitest";
import { buildCoachingPlan, COACHING_DISCLAIMER, happenstanceReview, type SkillRating } from "../../src/coach.js";
import type { ActionLedgerEntry } from "../../src/types.js";

function ratings(overrides: Partial<Record<SkillRating["skill"], SkillRating["rating"]>> = {}): SkillRating[] {
  const base: Record<SkillRating["skill"], SkillRating["rating"]> = {
    curiosity: 3,
    persistence: 3,
    flexibility: 3,
    optimism: 3,
    "risk-taking": 3
  };
  const merged = { ...base, ...overrides };
  return (Object.keys(merged) as Array<SkillRating["skill"]>).map((skill) => ({
    skill,
    rating: merged[skill]
  }));
}

function ledgerEntry(result: ActionLedgerEntry["result"]): ActionLedgerEntry {
  return {
    actionId: "A-2026-00000000-0000-0000-0000-000000000000",
    timestamp: "2026-07-06T00:00:00.000Z",
    mode: "/deep-fit",
    opportunityId: "OPP-DEMO-001",
    reversibilityTag: "R3",
    evidenceGatePassed: true,
    approvalRequired: true,
    approvalReceived: false,
    highStakesGatePassed: true,
    result
  };
}

describe("skill coach", () => {
  it("focuses on the lowest rated happenstance skills", () => {
    const { plan, gate } = buildCoachingPlan({
      ratings: ratings({ "risk-taking": 1, flexibility: 2 })
    });
    expect(plan.focusSkills).toEqual(["risk-taking", "flexibility"]);
    expect(plan.reversibilityTag).toBe("R0");
    expect(plan.disclaimer).toBe(COACHING_DISCLAIMER);
    expect(plan.practices.every((practice) => practice.reversibilityTag === "R0")).toBe(true);
    expect(gate.mode).toBe("/skill-coach");
    expect(gate.humanApprovalRequired).toBe(false);
  });

  it("falls back to a single maintenance focus when all skills are strong", () => {
    const { plan } = buildCoachingPlan({ ratings: ratings() });
    expect(plan.focusSkills.length).toBe(1);
  });

  it("adds a referral note and gates when the clinical flag is set", () => {
    const { plan, gate } = buildCoachingPlan({
      ratings: ratings({ optimism: 0 }),
      highStakesFlags: { clinicalOrMentalHealthSensitive: true }
    });
    expect(plan.referralNote).toBeDefined();
    expect(gate.humanApprovalRequired).toBe(true);
    expect(gate.highStakesCertaintyGate).toBe(true);
  });

  it("rejects duplicate or missing skill ratings", () => {
    const duplicated = ratings();
    duplicated[1] = { ...duplicated[0]! };
    expect(() => buildCoachingPlan({ ratings: duplicated })).toThrow(/Duplicate skill rating/);
    expect(() => buildCoachingPlan({ ratings: ratings().slice(0, 4) })).toThrow(/Expected 5 skill ratings/);
  });
});

describe("happenstance review", () => {
  it("treats blocked actions as information", () => {
    const prompts = happenstanceReview([ledgerEntry("blocked")]);
    expect(prompts[0]).toContain("blocked");
    expect(prompts[0]).toContain("information, not failure");
  });

  it("offers a starting prompt for an empty ledger", () => {
    const prompts = happenstanceReview([]);
    expect(prompts[0]).toContain("ledger is empty");
  });

  it("stays within the prompt limit and is deterministic", () => {
    const entries = [ledgerEntry("blocked"), ledgerEntry("submitted"), ledgerEntry("draft_generated")];
    const first = happenstanceReview(entries, 3);
    const second = happenstanceReview(entries, 3);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(3);
  });
});
