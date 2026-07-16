import { describe, expect, it, vi } from "vitest";
import { createTuiDaemonQueueClient } from "../../src/tui/index.js";

function record(domain: string, recordId: string, version: number, value: Record<string, unknown>) {
  return { domain, recordId, version, status: "active", value, valueHash: "sha256:test", operationId: "REQ-TEST-12345678", recordedAt: "2026-07-14T12:00:00.000Z" };
}

describe("TUI daemon queue adapter", () => {
  const applicationQuery = {
    queueKinds: ["applications"] as const,
    statuses: ["approved"] as const,
    query: "example",
    attentionOnly: true,
    providers: [] as const,
    liveness: [] as const,
    duplicateStatuses: [] as const,
    minimumTaxonomyConfidence: null,
    truthStatuses: [] as const,
    campaignIds: [] as const
  };

  it("joins application attempts to canonical opportunity records", async () => {
    const request = vi.fn(async (operation: string) => operation === "tracker-list"
      ? [record("applications", "ATT-1", 3, {
        attemptId: "ATT-1",
        opportunityId: "OPP-1",
        adapterId: "greenhouse",
        status: "approved",
        updatedAt: "2026-07-14T12:00:00.000Z",
        packetHash: "sha256:packet",
        approvalId: "APR-1",
        proofId: null,
        blocker: null
      })]
      : [record("opportunities", "OPP-1", 1, {
        opportunityId: "OPP-1",
        roleTitle: "AI Safety Researcher",
        company: "Example Lab",
        locationText: "Remote"
      })]);
    const client = createTuiDaemonQueueClient({ request });
    const items = await client.queryQueue(applicationQuery);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "AI Safety Researcher", organization: "Example Lab" });
    expect(items[0]?.evidence.map((item) => item.status)).toEqual(["verified", "operator-supplied", "missing"]);
  });

  it("creates review tasks without exposing a submission operation", async () => {
    const request = vi.fn(async () => ({}));
    const client = createTuiDaemonQueueClient({ request });
    const result = await client.executeQueueCommand({
      kind: "approval.request",
      attemptId: "ATT-1",
      opportunityId: "OPP-1",
      expectedVersion: 3
    });
    expect(result.accepted).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "domain-put",
      expect.objectContaining({ domain: "tasks", expectedVersion: 0 }),
      { requestId: expect.stringMatching(/^REQ-TUI-/) }
    );
    expect(request.mock.calls.flat()).not.toContain("tracker-submit");
  });

  it("routes blocking through the version-bound tracker authority", async () => {
    const request = vi.fn(async () => ({}));
    const client = createTuiDaemonQueueClient({ request });
    await expect(client.executeQueueCommand({
      kind: "attempt.block",
      attemptId: "ATT-1",
      opportunityId: "OPP-1",
      expectedVersion: 3
    })).resolves.toMatchObject({ accepted: true });
    expect(request).toHaveBeenCalledWith(
      "tracker-block",
      expect.objectContaining({ attemptId: "ATT-1", expectedVersion: 3 }),
      { requestId: expect.stringMatching(/^REQ-TUI-/) }
    );
  });

  it("reads the bounded discovery projection and records proposals only as audited tasks", async () => {
    const request = vi.fn(async (operation: string) => operation === "discovery-review-list"
      ? {
        items: [{
          opportunityId: "OPP-DISCOVERY-1",
          version: 2,
          roleTitle: "Research Engineer",
          company: "Evidence Lab",
          locationText: "Remote",
          providerId: "greenhouse",
          sourceKey: "greenhouse:posting-1",
          status: "needs_review",
          liveness: "unresolved",
          livenessConfidence: "low",
          truthDisposition: "blocked",
          truthBlockers: ["workAuthorization:mandatory-unresolved"],
          duplicateStatus: "review",
          duplicateCandidateIds: ["OPP-DISCOVERY-2"],
          taxonomyConfidence: 0.71,
          campaignId: "CAMPAIGN-1",
          updatedAt: "2026-07-14T12:00:00.000Z",
          evidenceRecordIds: ["LIVE-ABC", "TRUTH-ABC", "DEDUPE-ABC"]
        }],
        nextCursor: null,
        limit: 100,
        pageHash: "sha256:page"
      }
      : {});
    const client = createTuiDaemonQueueClient({ request });
    const items = await client.queryQueue({
      queueKinds: ["discovery"],
      statuses: ["needs_review"],
      query: "evidence",
      attentionOnly: true,
      providers: ["greenhouse"],
      liveness: ["unresolved"],
      duplicateStatuses: ["review"],
      minimumTaxonomyConfidence: 0.7,
      truthStatuses: ["blocked"],
      campaignIds: ["CAMPAIGN-1"]
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queueKind: "discovery", opportunityId: "OPP-DISCOVERY-1" });

    await client.executeQueueCommand({
      kind: "discovery.merge-proposal",
      attemptId: "OPP-DISCOVERY-1",
      opportunityId: "OPP-DISCOVERY-1",
      expectedVersion: 2
    });
    expect(request).toHaveBeenLastCalledWith(
      "domain-put",
      expect.objectContaining({
        domain: "tasks",
        value: expect.objectContaining({ relatedDomain: "opportunities", relatedRecordId: "OPP-DISCOVERY-1" })
      }),
      { requestId: expect.stringMatching(/^REQ-TUI-/) }
    );
    expect(request.mock.calls.flat()).not.toContain("dedupe-result-record");
    expect(request.mock.calls.flat()).not.toContain("tracker-submit");
  });
});
