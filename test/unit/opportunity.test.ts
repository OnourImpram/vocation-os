import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  createOpportunityRecord,
  evaluateOpportunityIntake,
  type OpportunityIntakePolicy
} from "../../src/opportunity.js";

const DESCRIPTION = "A substantive synthetic role description focused on responsible AI product work, evaluation, research operations, and evidence grounded decision systems.";

function record(overrides: Partial<Parameters<typeof createOpportunityRecord>[0]> = {}) {
  return createOpportunityRecord({
    source: "manual",
    sourceId: "123",
    sourceUrl: "https://jobs.example.test/roles/123?utm_source=test",
    canonicalUrl: "https://jobs.example.test/roles/123",
    applyUrl: "https://jobs.example.test/roles/123/apply",
    company: "Example Labs",
    roleTitle: "Responsible AI Product Manager",
    locationText: "Remote, Europe",
    remotePolicy: "remote",
    applicantLocationRequirements: ["Europe"],
    descriptionText: DESCRIPTION,
    postedAt: "2026-07-01T00:00:00.000Z",
    capturedAt: "2026-07-10T00:00:00.000Z",
    extractionConfidence: "high",
    sourcePayload: { id: 123, title: "Responsible AI Product Manager" },
    ...overrides
  });
}

function policy(overrides: Partial<OpportunityIntakePolicy> = {}): OpportunityIntakePolicy {
  return {
    requiresRemote: true,
    requireExplicitApplicantLocation: true,
    candidateRegions: ["Europe", "EU", "Türkiye"],
    maxAgeDays: 45,
    minimumDescriptionCharacters: 80,
    existingFingerprints: [],
    evaluatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}

describe("opportunity provenance and intake", () => {
  it("accepts a current explicit remote opportunity with matching geography", () => {
    const opportunity = record();
    const decision = evaluateOpportunityIntake(opportunity, policy());
    expect(decision.status).toBe("accepted");
    expect(decision.gates.every((entry) => entry.outcome === "pass")).toBe(true);
  });

  it("routes remote work with unknown applicant geography to manual review", () => {
    const opportunity = record({ applicantLocationRequirements: [] });
    const decision = evaluateOpportunityIntake(opportunity, policy());
    expect(decision.status).toBe("manual_review");
    expect(decision.reasons).toContain("remote eligibility geography is not explicit");
  });

  it("rejects hybrid work when remote work is required", () => {
    const decision = evaluateOpportunityIntake(record({ remotePolicy: "hybrid" }), policy());
    expect(decision.status).toBe("rejected");
    expect(decision.reasons).toContain("role is hybrid");
  });

  it("rejects an existing opportunity fingerprint", () => {
    const opportunity = record();
    const decision = evaluateOpportunityIntake(opportunity, policy({ existingFingerprints: [opportunity.fingerprint] }));
    expect(decision.status).toBe("rejected");
    expect(decision.reasons).toContain("opportunity fingerprint already exists");
  });

  it("removes known tracking parameters but preserves application identifiers", () => {
    expect(canonicalizeUrl("https://jobs.example.test/apply?gh_jid=42&utm_source=mail&ref=campaign")).toBe(
      "https://jobs.example.test/apply?gh_jid=42&ref=campaign"
    );
    expect(canonicalizeUrl("https://jobs.example.test/apply?source=partner&lever-source=mail")).toBe(
      "https://jobs.example.test/apply?source=partner"
    );
  });

  it("produces stable source and opportunity fingerprints", () => {
    const left = record({ sourcePayload: { title: "Role", id: 123 } });
    const right = record({ sourcePayload: { id: 123, title: "Role" } });
    expect(left.sourcePayloadHash).toBe(right.sourcePayloadHash);
    expect(left.fingerprint).toBe(right.fingerprint);
  });
});
