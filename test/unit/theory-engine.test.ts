import { describe, expect, it } from "vitest";
import {
  classifyDecisionDifficulties,
  composeTheoryBrief,
  lensesForMode,
  optionValueNote,
  questionsForMode
} from "../../src/theory-engine.js";
import { THEORY_NAMES, THEORY_REGISTRY, validateTheoryRegistry } from "../../src/theory.js";
import { MODE_NAMES } from "../../src/types.js";

describe("theory registry", () => {
  it("passes structural validation", () => {
    const result = validateTheoryRegistry();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("keeps the registry and the public name list in bijection", () => {
    expect(THEORY_REGISTRY.length).toBe(THEORY_NAMES.length);
  });

  it("gives every citation an author, year, title, and source", () => {
    for (const lens of THEORY_REGISTRY) {
      expect(lens.citations.length).toBeGreaterThan(0);
      for (const citation of lens.citations) {
        expect(citation.authors.length).toBeGreaterThan(0);
        expect(citation.title.length).toBeGreaterThan(0);
        expect(citation.source.length).toBeGreaterThan(0);
        expect(citation.year).toBeGreaterThan(1900);
      }
    }
  });

  it("covers every mode with at least one theory lens", () => {
    for (const mode of MODE_NAMES) {
      expect(lensesForMode(mode).length, `mode without lens: ${mode}`).toBeGreaterThan(0);
    }
  });
});

describe("theory engine", () => {
  it("caps and deduplicates guiding questions", () => {
    const questions = questionsForMode("/deep-fit", { limit: 4 });
    expect(questions.length).toBeLessThanOrEqual(4);
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("puts specialist questions ahead of theory questions when flags are set", () => {
    const questions = questionsForMode("/deep-fit", {
      limit: 6,
      highStakesFlags: { familyRelocationSensitive: true }
    });
    expect(questions[0]).toContain("family system");
  });

  it("explains why R4 never auto submits through option value", () => {
    expect(optionValueNote("R4")).toContain("never auto submits");
  });

  it("composes a brief with sorted unique rubric focus", () => {
    const brief = composeTheoryBrief("/deep-fit", "R0");
    expect(brief.lenses.length).toBeGreaterThan(0);
    const sorted = [...brief.rubricFocus].sort();
    expect(brief.rubricFocus).toEqual(sorted);
    expect(new Set(brief.rubricFocus).size).toBe(brief.rubricFocus.length);
  });
});

describe("decision difficulty intake", () => {
  it("routes inconsistent information to steelman and evidence work", () => {
    const profile = classifyDecisionDifficulties({ internalConflicts: true, unreliableInformation: true });
    expect(profile.primaryCluster).toBe("inconsistent-information");
    expect(profile.recommendedNextModes).toContain("/steelman");
    expect(profile.recommendedNextModes).toContain("/evidence-gap");
  });

  it("routes readiness difficulties to the skill coach", () => {
    const profile = classifyDecisionDifficulties({ lowMotivation: true });
    expect(profile.primaryCluster).toBe("lack-of-readiness");
    expect(profile.recommendedNextModes).toContain("/skill-coach");
  });

  it("returns an empty profile when nothing is flagged", () => {
    const profile = classifyDecisionDifficulties({});
    expect(profile.clusters).toEqual([]);
    expect(profile.primaryCluster).toBeNull();
    expect(profile.recommendedNextModes).toEqual([]);
  });

  it("picks the cluster with the most flags as primary", () => {
    const profile = classifyDecisionDifficulties({
      lowMotivation: true,
      missingSelfKnowledge: true,
      missingOccupationKnowledge: true
    });
    expect(profile.primaryCluster).toBe("lack-of-information");
  });
});
