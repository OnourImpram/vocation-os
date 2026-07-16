import { describe, expect, it } from "vitest";
import {
  assertDedupeResult,
  deduplicateCandidates,
  evaluateDedupePair,
  type DedupeCandidate,
  type DedupeResult
} from "../../src/discovery/dedupe.js";
import { sha256, stableStringify } from "../../src/hash.js";

const DESCRIPTION_HASH = `sha256:${"b".repeat(64)}`;

function candidate(overrides: Partial<DedupeCandidate> = {}): DedupeCandidate {
  return {
    candidateId: "candidate-A",
    observationId: `OBS-${"A".repeat(32)}`,
    providerId: "greenhouse",
    sourceRecordId: "record-1",
    canonicalUrl: "https://jobs.example.com/openings/record-1",
    applyUrl: "https://apply.example.com/record-1",
    company: "Example Labs",
    companyDomain: "example.com",
    roleTitle: "Machine Learning Engineer",
    location: "Remote, Europe",
    postedAt: "2026-07-14T08:00:00.000Z",
    descriptionDigest: DESCRIPTION_HASH,
    taxonomyConceptIds: ["esco:2512.1"],
    ...overrides
  };
}

describe("deterministic discovery dedupe", () => {
  it("merges cross-source records with the same governed application endpoint", () => {
    const left = candidate();
    const right = candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "different-provider-id",
      canonicalUrl: "https://jobs.lever.co/example/different-provider-id"
    });
    const result = deduplicateCandidates([left, right]);
    expect(result.clusters).toHaveLength(1);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      outcome: "merge",
      reason: "same-application-endpoint",
      companyDomainMatch: true
    }));
  });

  it("does not merge identical titles and content across different company domains", () => {
    const left = candidate();
    const right = candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.other.example/openings/record-2",
      applyUrl: "https://apply.other.example/record-2",
      company: "Example Labs",
      companyDomain: "other.example"
    });
    const result = deduplicateCandidates([left, right]);
    expect(result.clusters).toHaveLength(2);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      outcome: "distinct",
      reason: "company-domain-conflict",
      companyDomainMatch: false
    }));
  });

  it("treats different records from one provider as distinct", () => {
    const decision = evaluateDedupePair(candidate(), candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.example.com/openings/record-2",
      applyUrl: "https://apply.example.com/record-2"
    }));
    expect(decision).toMatchObject({ outcome: "distinct", reason: "provider-record-conflict" });
  });

  it("does not trust a reused provider record ID when company identity conflicts", () => {
    const decision = evaluateDedupePair(
      candidate({ companyDomain: null }),
      candidate({
        candidateId: "candidate-B",
        observationId: `OBS-${"B".repeat(32)}`,
        company: "Different Employer",
        companyDomain: null
      })
    );
    expect(decision).toMatchObject({ outcome: "distinct", reason: "material-identity-mismatch" });
  });

  it("does not trust a reused provider record ID when title or location conflicts", () => {
    const titleConflict = evaluateDedupePair(candidate(), candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      roleTitle: "Security Engineer"
    }));
    expect(titleConflict).toMatchObject({ outcome: "distinct", reason: "material-identity-mismatch" });

    const locationConflict = evaluateDedupePair(candidate(), candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      location: "New York, USA"
    }));
    expect(locationConflict).toMatchObject({ outcome: "distinct", reason: "material-identity-mismatch" });
  });

  it("does not merge a shared application endpoint without posting-specific corroboration", () => {
    const decision = evaluateDedupePair(candidate(), candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.lever.co/example/record-2",
      applyUrl: "https://apply.example.com/record-1",
      descriptionDigest: `sha256:${"c".repeat(64)}`
    }));
    expect(decision).toMatchObject({ outcome: "review", reason: "identity-evidence-insufficient" });
  });

  it("uses taxonomy adjacency only for review and never as independent merge evidence", () => {
    const decision = evaluateDedupePair(candidate(), candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.lever.co/example/record-2",
      applyUrl: "https://apply.example.com/record-2",
      roleTitle: "Applied Machine Learning Scientist",
      taxonomyConceptIds: ["onet:15-2051.00"]
    }), {
      taxonomyAdjacency: { adjacency: () => 0.91 }
    });
    expect(decision).toMatchObject({
      outcome: "review",
      reason: "taxonomy-adjacent-role",
      taxonomyAdjacency: 0.91
    });
  });

  it("prevents a bridge record from transitively merging conflicting provider records", () => {
    const first = candidate({
      candidateId: "candidate-A",
      sourceRecordId: "record-1",
      canonicalUrl: "https://jobs.example.com/openings/record-1",
      applyUrl: "https://apply.example.com/shared"
    });
    const bridge = candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "bridge",
      canonicalUrl: "https://jobs.example.com/openings/record-2",
      applyUrl: "https://apply.example.com/shared"
    });
    const second = candidate({
      candidateId: "candidate-C",
      observationId: `OBS-${"C".repeat(32)}`,
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.example.com/openings/record-2",
      applyUrl: "https://apply.example.com/record-2"
    });
    const result = deduplicateCandidates([first, bridge, second]);
    expect(result.clusters).toHaveLength(2);
    expect(Math.max(...result.clusters.map((cluster) => cluster.memberCandidateIds.length))).toBe(2);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      outcome: "distinct",
      reason: "cluster-identity-conflict"
    }));
  });

  it("produces the same result identity regardless of input order", () => {
    const left = candidate();
    const right = candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.lever.co/example/record-2"
    });
    expect(deduplicateCandidates([left, right]).resultId)
      .toBe(deduplicateCandidates([right, left]).resultId);
  });

  it("recomputes persisted cluster and result identities and rejects tampering", () => {
    const result = deduplicateCandidates([candidate(), candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.lever.co/example/record-2"
    })]);
    expect(() => assertDedupeResult(result)).not.toThrow();
    const tamperedId = { ...result, resultId: `DEDUP-${"0".repeat(32)}` } as DedupeResult;
    expect(() => assertDedupeResult(tamperedId)).toThrow(/integrity check failed/);
    const tamperedCluster = {
      ...result,
      clusters: [{ ...result.clusters[0]!, memberCandidateIds: ["candidate-A"] }, ...result.clusters.slice(1)]
    } as DedupeResult;
    expect(() => assertDedupeResult(tamperedCluster)).toThrow(/cluster integrity check failed/);
  });

  it("rejects recomputed payload hashes when cluster membership is not implied by merge decisions", () => {
    const result = deduplicateCandidates([candidate(), candidate({
      candidateId: "candidate-B",
      observationId: `OBS-${"B".repeat(32)}`,
      providerId: "lever",
      sourceRecordId: "record-2",
      canonicalUrl: "https://jobs.lever.co/example/record-2"
    })]);
    const decisions = result.decisions.map((decision) => ({
      ...decision,
      outcome: "review" as const,
      reason: "identity-evidence-insufficient" as const
    }));
    const core = { clusters: result.clusters, decisions };
    const digest = sha256(stableStringify(core))
      .slice("sha256:".length, "sha256:".length + 32)
      .toUpperCase();
    const forged = { ...core, schemaVersion: "1.0.0" as const, resultId: `DEDUP-${digest}` };
    expect(() => assertDedupeResult(forged)).toThrow(/not derivable from merge decisions/);
  });
});
