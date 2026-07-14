import { describe, expect, it } from "vitest";
import { normalizeAshbyPosting, normalizeGreenhouseJob, normalizeLeverPosting } from "../../src/adapters.js";

const context = {
  company: "Example Labs",
  sourceUrl: "https://jobs.example.test/board",
  applicantLocationRequirements: ["Europe"],
  capturedAt: "2026-07-10T00:00:00.000Z"
};

describe("public ATS adapters", () => {
  it("normalizes a Greenhouse job without executing markup", () => {
    const opportunity = normalizeGreenhouseJob(
      {
        id: 42,
        title: "AI Safety Researcher",
        absolute_url: "https://boards.greenhouse.io/example/jobs/42",
        location: { name: "Remote, Europe" },
        content: "<p>Study responsible AI systems.</p><script>throw new Error('never execute')</script>"
      },
      { ...context, postedAt: "2026-07-01T00:00:00.000Z" }
    );
    expect(opportunity.source).toBe("greenhouse");
    expect(opportunity.descriptionText).toBe("Study responsible AI systems.");
    expect(opportunity.remotePolicy).toBe("remote");
  });

  it("removes malformed script blocks and decodes basic text entities", () => {
    const opportunity = normalizeGreenhouseJob(
      {
        id: 43,
        title: "Responsible AI Lead",
        absolute_url: "https://boards.greenhouse.io/example/jobs/43",
        location: { name: "Remote" },
        content: "<div>Evidence &amp; safety&nbsp;work</div><script>alert(1)</script ignored=\"true\"><p>Human &lt; review &gt;</p>"
      },
      context
    );
    expect(opportunity.descriptionText).toBe("Evidence & safety work Human < review >");
  });

  it("normalizes Lever workplace and salary fields", () => {
    const opportunity = normalizeLeverPosting(
      {
        id: "lever-1",
        text: "AI Product Manager",
        hostedUrl: "https://jobs.lever.co/example/lever-1",
        applyUrl: "https://jobs.lever.co/example/lever-1/apply",
        workplaceType: "remote",
        categories: { location: "Europe" },
        descriptionPlain: "Lead a responsible AI product portfolio with research and engineering partners.",
        createdAt: Date.parse("2026-07-02T00:00:00.000Z"),
        salaryRange: { currency: "USD", interval: "year", min: 90000, max: 120000 }
      },
      context
    );
    expect(opportunity.remotePolicy).toBe("remote");
    expect(opportunity.compensationText).toBe("USD 90000-120000 year");
    expect(opportunity.postedAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("normalizes Ashby public posting fields", () => {
    const opportunity = normalizeAshbyPosting(
      {
        id: "ashby-1",
        title: "Clinical AI Safety Lead",
        jobUrl: "https://jobs.ashbyhq.com/example/ashby-1",
        applyUrl: "https://jobs.ashbyhq.com/example/ashby-1/application",
        location: "Remote, Europe",
        isRemote: true,
        descriptionPlain: "Build evaluation and safety systems for high consequence clinical AI workflows.",
        publishedAt: "2026-07-03T00:00:00.000Z",
        compensationTierSummary: "USD 100,000 to 140,000"
      },
      context
    );
    expect(opportunity.source).toBe("ashby");
    expect(opportunity.remotePolicy).toBe("remote");
    expect(opportunity.compensationText).toContain("100,000");
  });

  it("rejects malformed source payloads", () => {
    expect(() => normalizeLeverPosting({ id: "missing-fields" }, context)).toThrow("Lever hostedUrl");
  });
});


