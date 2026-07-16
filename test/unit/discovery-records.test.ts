import { describe, expect, it } from "vitest";
import { deriveDiscoveryPosting } from "../../src/discovery/discovery-records.js";
import type { DiscoveredProviderPosting } from "../../src/discovery/provider-adapters.js";
import { createSourceObservation } from "../../src/discovery/source-observation.js";
import { providerManifestById } from "../../src/discovery/providers.js";
import { sha256 } from "../../src/hash.js";

const CAPTURED_AT = "2026-07-14T12:00:00.000Z";

function endpointObservation() {
  return createSourceObservation({
    providerId: "greenhouse",
    providerManifestVersion: providerManifestById("greenhouse").egress.version,
    sourceKey: "greenhouse:demo-board",
    requestedUrl: "https://boards-api.greenhouse.io/v1/boards/demo/jobs",
    finalUrl: "https://boards-api.greenhouse.io/v1/boards/demo/jobs",
    observedAt: CAPTURED_AT,
    availability: "available",
    httpStatus: 200,
    contentType: "application/json",
    bodyDigest: sha256("fixture body"),
    cacheState: "bypass",
    redirectCount: 0,
    fields: [],
    uncertainty: []
  });
}

function posting(applyUrl: string | null): DiscoveredProviderPosting {
  return {
    postingId: "POST-GREENHOUSE-42",
    providerId: "greenhouse",
    sourceRecordId: "42",
    sourceUrl: "https://boards-api.greenhouse.io/v1/boards/demo/jobs",
    canonicalUrl: "https://boards.greenhouse.io/demo/jobs/42",
    applyUrl,
    company: "Demo Research",
    roleTitle: "Career Decision Scientist",
    location: "Remote, Europe",
    descriptionText: "Build evidence grounded career decision systems.",
    postedAt: "2026-07-13T12:00:00.000Z",
    deadline: null,
    capturedAt: CAPTURED_AT,
    sourcePayloadHash: sha256("posting-42")
  };
}

describe("derived discovery records", () => {
  it("binds a provider posting to observation, liveness, truth, and dedupe evidence", () => {
    const result = deriveDiscoveryPosting(
      posting("https://boards.greenhouse.io/demo/jobs/42#apply"),
      endpointObservation()
    );

    expect(result.opportunity).toMatchObject({
      source: "greenhouse",
      sourceId: "42",
      remotePolicy: "remote"
    });
    expect(result.observation.sourceKey).toBe("greenhouse:42");
    expect(result.liveness).toMatchObject({ state: "live", evidenceObservationIds: [result.observation.observationId] });
    expect(result.truth).toMatchObject({
      opportunityKey: result.opportunity.opportunityId,
      disposition: "blocked"
    });
    expect(result.truth.blockers).toEqual(expect.arrayContaining([
      { field: "workAuthorization", code: "mandatory-unresolved" },
      { field: "licensing", code: "mandatory-unresolved" },
      { field: "deadline", code: "mandatory-unresolved" }
    ]));
    expect(result.dedupeCandidate).toMatchObject({
      candidateId: result.opportunity.opportunityId,
      observationId: result.observation.observationId
    });
  });

  it("does not classify a posting without an application endpoint as live", () => {
    const result = deriveDiscoveryPosting(posting(null), endpointObservation());
    expect(result.observation.availability).toBe("available");
    expect(result.liveness.state).toBe("unresolved");
  });

  it("rejects a posting that is not bound to its endpoint observation", () => {
    expect(() => deriveDiscoveryPosting(
      { ...posting(null), providerId: "lever" },
      endpointObservation()
    )).toThrow("does not match");
  });
});
