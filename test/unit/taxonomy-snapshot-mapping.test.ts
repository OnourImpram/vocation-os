import { describe, expect, it } from "vitest";
import {
  createTaxonomyMappingSet,
  proposeTaxonomyMappings,
  rankTaxonomyConcepts,
  validateTaxonomyMappingSet,
  type TaxonomyMappingSet
} from "../../src/taxonomy/mapping.js";
import {
  createTaxonomySnapshot,
  validateTaxonomySnapshot,
  type TaxonomyConceptInput,
  type TaxonomySnapshot
} from "../../src/taxonomy/snapshot.js";

const ESCO_CONCEPTS: readonly TaxonomyConceptInput[] = [
  {
    conceptId: "esco:2512.1",
    code: "2512.1",
    preferredLabel: "Artificial intelligence engineer",
    language: "en",
    alternateLabels: ["AI engineer", "Machine intelligence engineer"],
    description: "Designs and develops artificial intelligence systems.",
    skillIds: ["esco:skill:machine-learning", "esco:skill:software-development"]
  },
  {
    conceptId: "esco:2512",
    code: "2512",
    preferredLabel: "Software developer",
    language: "en",
    alternateLabels: ["Software engineer"],
    description: "Develops software systems.",
    skillIds: ["esco:skill:software-development"]
  }
];

function esco(concepts: readonly TaxonomyConceptInput[] = ESCO_CONCEPTS) {
  return createTaxonomySnapshot({
    source: "esco",
    version: "1.2.0",
    completeness: "partial",
    sourceUrl: "https://esco.ec.europa.eu/en/classification/occupation_main",
    retrievedAt: "2026-07-14T10:00:00.000Z",
    publishedAt: "2024-05-15T00:00:00.000Z",
    license: {
      name: "European Commission reuse notice",
      url: "https://commission.europa.eu/legal-notice_en"
    },
    concepts
  });
}

function onet() {
  return createTaxonomySnapshot({
    source: "onet",
    version: "30.0",
    completeness: "partial",
    sourceUrl: "https://www.onetcenter.org/database.html",
    retrievedAt: "2026-07-14T10:05:00.000Z",
    publishedAt: null,
    license: {
      name: "O*NET Database license",
      url: "https://www.onetcenter.org/license_db.html"
    },
    concepts: [
      {
        conceptId: "onet:15-2051.00",
        code: "15-2051.00",
        preferredLabel: "Data Scientists",
        language: "en",
        alternateLabels: ["Artificial Intelligence Engineer", "Machine Learning Engineer"],
        description: "Develops analytical and machine learning systems.",
        skillIds: ["onet:skill:programming", "onet:skill:systems-analysis"]
      }
    ]
  });
}

describe("ESCO and O*NET taxonomy snapshots and mapping", () => {
  it("creates deterministic content-bound snapshots", () => {
    const left = esco(ESCO_CONCEPTS);
    const right = esco([...ESCO_CONCEPTS].reverse());
    expect(left.snapshotId).toBe(right.snapshotId);
    expect(left.contentHash).toBe(right.contentHash);
    expect(left.concepts.map((concept) => concept.conceptId)).toEqual(["esco:2512", "esco:2512.1"]);
  });

  it("binds source URL, timestamps, and license into independent provenance identity", () => {
    const original = esco();
    const alternateProvenance = createTaxonomySnapshot({
      source: "esco",
      version: "1.2.0",
      completeness: "partial",
      sourceUrl: "https://esco.ec.europa.eu/en/classification/occupation_main?release=1.2.0",
      retrievedAt: "2026-07-14T10:01:00.000Z",
      publishedAt: "2024-05-15T00:00:00.000Z",
      license: {
        name: "European Commission reuse notice",
        url: "https://commission.europa.eu/legal-notice_en"
      },
      concepts: ESCO_CONCEPTS
    });
    expect(alternateProvenance.contentHash).toBe(original.contentHash);
    expect(alternateProvenance.provenanceHash).not.toBe(original.provenanceHash);
    expect(alternateProvenance.snapshotId).not.toBe(original.snapshotId);
  });

  it("rejects taxonomy snapshots whose provenance changes without recomputed hashes", () => {
    const original = esco();
    const tampered = {
      ...original,
      license: { ...original.license, name: "Unverified replacement license" }
    } as TaxonomySnapshot;
    const validation = validateTaxonomySnapshot(tampered);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.errors).toEqual(expect.arrayContaining([
        "provenanceHash does not match canonical taxonomy provenance"
      ]));
    }
  });

  it("preserves both snapshot versions and hashes in curated mapping provenance", () => {
    const escoSnapshot = esco();
    const onetSnapshot = onet();
    const mappings = createTaxonomyMappingSet({
      mappingVersion: "2026.07",
      createdAt: "2026-07-14T10:10:00.000Z",
      fromSnapshot: escoSnapshot,
      toSnapshot: onetSnapshot,
      entries: [
        {
          fromConceptId: "esco:2512.1",
          toConceptId: "onet:15-2051.00",
          relation: "close",
          confidence: 0.92,
          method: "curated",
          evidence: [
            {
              sourceUrl: "https://example.org/crosswalk/2026-07",
              retrievedAt: "2026-07-14T10:09:00.000Z",
              note: "Curated semantic crosswalk reviewed against both source definitions."
            }
          ]
        }
      ]
    });
    expect(mappings.fromSnapshot).toMatchObject({
      source: "esco",
      version: "1.2.0",
      contentHash: escoSnapshot.contentHash
    });
    expect(mappings.toSnapshot).toMatchObject({
      source: "onet",
      version: "30.0",
      contentHash: onetSnapshot.contentHash
    });
    expect(mappings.mappings[0]).toMatchObject({ relation: "close", method: "curated" });
  });

  it("binds deterministic title matches to snapshot provenance", () => {
    const snapshot = esco();
    const matches = rankTaxonomyConcepts("AI engineer", snapshot, { minimumScore: 0.5 });
    expect(matches[0]).toMatchObject({
      conceptId: "esco:2512.1",
      score: 1,
      method: "deterministic-label-v1",
      provenance: {
        snapshotId: snapshot.snapshotId,
        source: "esco",
        version: "1.2.0",
        contentHash: snapshot.contentHash
      }
    });
  });

  it("keeps deterministic cross-taxonomy proposals below exact-equivalence confidence", () => {
    const proposals = proposeTaxonomyMappings(esco(), onet(), 0.5);
    const proposal = proposals.find((entry) => entry.fromConceptId === "esco:2512.1");
    expect(proposal).toMatchObject({
      toConceptId: "onet:15-2051.00",
      relation: "close",
      method: "deterministic-label",
      confidence: 0.89
    });
    expect(proposal?.provenance.fromSnapshot.version).toBe("1.2.0");
    expect(proposal?.provenance.toSnapshot.version).toBe("30.0");
  });

  it("rejects exact equivalence asserted by label matching alone", () => {
    expect(() => createTaxonomyMappingSet({
      mappingVersion: "2026.07",
      createdAt: "2026-07-14T10:10:00.000Z",
      fromSnapshot: esco(),
      toSnapshot: onet(),
      entries: [
        {
          fromConceptId: "esco:2512.1",
          toConceptId: "onet:15-2051.00",
          relation: "exact",
          confidence: 1,
          method: "deterministic-label",
          evidence: [
            {
              sourceUrl: "https://example.org/label-match",
              retrievedAt: "2026-07-14T10:09:00.000Z",
              note: "Label-only proposal."
            }
          ]
        }
      ]
    })).toThrow("cannot assert exact");
  });

  it("rejects persisted mapping sets with tampered snapshot provenance", () => {
    const mappingSet = createTaxonomyMappingSet({
      mappingVersion: "2026.07",
      createdAt: "2026-07-14T10:10:00.000Z",
      fromSnapshot: esco(),
      toSnapshot: onet(),
      entries: [{
        fromConceptId: "esco:2512.1",
        toConceptId: "onet:15-2051.00",
        relation: "close",
        confidence: 0.92,
        method: "curated",
        evidence: [{
          sourceUrl: "https://example.org/crosswalk/2026-07",
          retrievedAt: "2026-07-14T10:09:00.000Z",
          note: "Curated semantic crosswalk reviewed against both source definitions."
        }]
      }]
    });
    expect(validateTaxonomyMappingSet(mappingSet)).toEqual({ valid: true, errors: [] });
    const tampered = {
      ...mappingSet,
      fromSnapshot: {
        ...mappingSet.fromSnapshot,
        retrievedAt: "2026-07-14T10:02:00.000Z"
      }
    } as TaxonomyMappingSet;
    const validation = validateTaxonomyMappingSet(tampered);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.errors.join(" ")).toMatch(/provenanceHash|contentHash|snapshotId/);
    }
  });
});
