import { describe, expect, it } from "vitest";
import { createOpportunityRecord } from "../../src/opportunity.js";
import { buildOpportunityGraph, titleAdjacency, type OccupationConcept } from "../../src/opportunity-graph.js";

const concept: OccupationConcept = {
  conceptId: "ESCO-AI-RESEARCHER",
  source: "esco",
  sourceVersion: "1.2.0",
  label: "Artificial Intelligence Researcher",
  language: "en",
  skillIds: ["typescript", "evaluation"]
};

function opportunity() {
  return createOpportunityRecord({
    source: "manual",
    sourceId: "AI-001",
    sourceUrl: "https://example.test/jobs/ai-001",
    applyUrl: "https://example.test/jobs/ai-001/apply",
    company: "Synthetic Lab",
    roleTitle: "AI Researcher",
    locationText: "Remote worldwide",
    remotePolicy: "remote",
    applicantLocationRequirements: ["worldwide"],
    descriptionText: "Build TypeScript evaluation systems for responsible AI research.",
    extractionConfidence: "high",
    sourcePayload: { id: "AI-001" }
  });
}

describe("opportunity and labor market graph", () => {
  it("links opportunities to versioned taxonomy concepts", () => {
    const graph = buildOpportunityGraph([opportunity()], [concept], new Date("2026-07-11T00:00:00.000Z"));
    expect(graph.links[0]).toMatchObject({ conceptId: concept.conceptId, provenance: { source: "esco", sourceVersion: "1.2.0" } });
    expect(graph.links[0]?.matchedSkillIds).toContain("typescript");
  });

  it("rejects duplicate opportunity fingerprints", () => {
    expect(() => buildOpportunityGraph([opportunity(), opportunity()], [concept])).toThrow("Duplicate opportunity");
  });

  it("computes title adjacency from transferable skills", () => {
    expect(titleAdjacency(concept, { ...concept, conceptId: "ONET-ALT", source: "onet", skillIds: ["typescript", "research"] })).toBeCloseTo(1 / 3, 3);
  });
});
