import { describe, expect, it, vi } from "vitest";
import { buildWorkbenchRoutePayload } from "../../src/workbench/route-payload.js";

const REQUEST_ID = () => "REQ-WORKBENCH-00000001";

describe("workbench route projections", () => {
  it("renders discovery truth, liveness, and dedupe from one bounded daemon projection", async () => {
    const request = vi.fn(async (operation: string) => {
      if (operation === "discovery-review-list") return {
        items: [{
          opportunityId: "OPP-1",
          version: 2,
          roleTitle: "Career Decision Scientist",
          company: "Evidence Lab",
          locationText: "Remote",
          providerId: "greenhouse",
          sourceKey: "greenhouse:42",
          status: "needs_review",
          liveness: "live",
          livenessConfidence: "high",
          truthDisposition: "blocked",
          truthBlockers: ["licensing:mandatory-unresolved"],
          duplicateStatus: "review",
          duplicateCandidateIds: ["OPP-2"],
          taxonomyConfidence: 0.78,
          campaignId: null,
          updatedAt: "2026-07-14T12:00:00.000Z",
          evidenceRecordIds: ["LIVE-1", "TRUTH-1", "DEDUPE-1"]
        }],
        nextCursor: null,
        limit: 100,
        pageHash: "sha256:page"
      };
      return [];
    });

    const payload = await buildWorkbenchRoutePayload("review", { request }, REQUEST_ID);
    expect(payload.items[0]).toMatchObject({
      id: "OPP-1",
      status: "needs_review",
      fields: expect.arrayContaining([
        { label: "Liveness", value: "live" },
        { label: "Truth", value: "blocked" },
        { label: "Dedupe", value: "review" }
      ])
    });
    expect(request).toHaveBeenCalledWith(
      "discovery-review-list",
      { cursor: null, limit: 100 },
      { requestId: REQUEST_ID() }
    );
  });

  it("exposes bounded Credential Passport summaries without raw credential content", async () => {
    const request = vi.fn(async (operation: string) => {
      if (operation === "credential-passport-list") return {
        items: [{ recordId: "CREDENTIAL-1" }],
        nextCursor: null,
        limit: 25,
        pageHash: "sha256:page"
      };
      if (operation === "credential-passport-get") return {
        domain: "credential-passport-records",
        recordId: "CREDENTIAL-1",
        version: 1,
        recordedAt: "2026-07-14T12:00:00.000Z",
        valueHash: "sha256:value",
        value: {
          passportEntryId: "CREDENTIAL-1",
          importedAt: "2026-07-14T12:00:00.000Z",
          envelopeFormat: "json-ld",
          summary: {
            achievementName: "Responsible AI Practice",
            issuerId: "https://issuer.example",
            subjectId: "did:example:operator",
            validFrom: "2026-01-01T00:00:00.000Z",
            validUntil: null
          },
          verification: { overall: "verified" },
          credential: { privateNarrative: "must-not-reach-browser" }
        }
      };
      return [];
    });

    const payload = await buildWorkbenchRoutePayload("credentials", { request }, REQUEST_ID);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ title: "Responsible AI Practice", status: "verified" });
    expect(JSON.stringify(payload)).not.toContain("must-not-reach-browser");
  });

  it("separates interview and offer stages without implying active services", async () => {
    const outcomes = [
      { recordId: "OUTCOME-I", version: 1, value: { outcomeId: "OUTCOME-I", stage: "interview", opportunityId: "OPP-1" } },
      { recordId: "OUTCOME-O", version: 1, value: { outcomeId: "OUTCOME-O", stage: "offer", opportunityId: "OPP-1" } }
    ];
    const request = vi.fn(async () => outcomes);
    const interview = await buildWorkbenchRoutePayload("interview", { request }, REQUEST_ID);
    const offers = await buildWorkbenchRoutePayload("offers", { request }, REQUEST_ID);

    expect(interview.items.map((item) => item.id)).toEqual(["OUTCOME-I"]);
    expect(interview.summary).toContain("No live audio session");
    expect(offers.items.map((item) => item.id)).toEqual(["OUTCOME-O"]);
    expect(offers.details.some((item) => item.value.includes("specialists"))).toBe(true);
  });
});
