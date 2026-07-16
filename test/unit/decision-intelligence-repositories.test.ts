import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256, stableStringify } from "../../src/hash.js";
import { providerManifestById } from "../../src/discovery/providers.js";
import {
  createSourceObservation,
  type SourceObservation
} from "../../src/discovery/source-observation.js";
import { assessSourceLiveness, DEFAULT_LIVENESS_POLICY } from "../../src/discovery/liveness.js";
import {
  createOpportunityTruthRecord,
  type OpportunityFieldTruthInput,
  type OpportunityTruthFieldName
} from "../../src/discovery/opportunity-truth.js";
import { deduplicateCandidates, type DedupeCandidate } from "../../src/discovery/dedupe.js";
import { createTaxonomySnapshot, type TaxonomySnapshot } from "../../src/taxonomy/snapshot.js";
import { createTaxonomyMappingSet } from "../../src/taxonomy/mapping.js";
import { createCareerAssuranceCase } from "../../src/assurance/index.js";
import {
  computeCredentialMappingHash,
  createCredentialClaimMapping,
  type CredentialClaimMapping,
  type CredentialCheck,
  type CredentialPassportEntry,
  type JsonObject
} from "../../src/credentials/index.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import {
  DECISION_INTELLIGENCE_DOMAINS,
  DecisionIntelligenceRepositories
} from "../../src/storage/decision-intelligence-repositories.js";

const PASSPHRASE = "decision intelligence repository passphrase";
const NOW = new Date("2026-07-14T12:30:00.000Z");
const OBSERVED_AT = "2026-07-14T12:00:00.000Z";
const SOURCE_URL = "https://boards-api.greenhouse.io/v1/boards/example/jobs/42";

function requestId(seed: number): string {
  return `REQ-DECISION-INTELLIGENCE-${seed.toString().padStart(4, "0")}`;
}

function observation(sourceKey = "greenhouse:job-42"): SourceObservation {
  return createSourceObservation({
    providerId: "greenhouse",
    providerManifestVersion: providerManifestById("greenhouse").egress.version,
    sourceKey,
    requestedUrl: SOURCE_URL,
    finalUrl: SOURCE_URL,
    observedAt: OBSERVED_AT,
    availability: "available",
    httpStatus: 200,
    contentType: "application/json",
    bodyDigest: sha256("governed source body"),
    cacheState: "bypass",
    redirectCount: 0,
    fields: [
      {
        field: "roleTitle",
        value: "Career Safety Engineer",
        confidence: "high",
        evidencePointer: "$.title"
      }
    ],
    uncertainty: []
  });
}

function truthField(source: SourceObservation, value: string): OpportunityFieldTruthInput {
  return {
    state: "observed",
    value,
    evidence: [{
      observationId: source.observationId,
      pointer: "$.job.field",
      observedAt: source.observedAt
    }],
    observedAt: source.observedAt,
    recencyPolicy: {
      policyId: "decision-intelligence.default-v1",
      maxAgeMs: 24 * 60 * 60_000,
      maxFutureSkewMs: 5 * 60_000,
      onExpiry: "stale"
    },
    rationale: "Directly observed in the governed provider response."
  };
}

function opportunityTruth(source: SourceObservation) {
  const values: Record<OpportunityTruthFieldName, string> = {
    salary: "USD 100000 to 120000",
    remoteConditions: "Remote in Europe",
    workAuthorization: "EU work authorization accepted",
    licensing: "No protected professional title required",
    location: "Remote, Europe",
    deadline: "2026-08-01T23:59:59.000Z"
  };
  return createOpportunityTruthRecord({
    opportunityKey: "greenhouse:example:job-42",
    assessedAt: NOW.toISOString(),
    mandatoryFields: Object.keys(values) as OpportunityTruthFieldName[],
    fields: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, truthField(source, value)])
    ) as Record<OpportunityTruthFieldName, OpportunityFieldTruthInput>
  });
}

function candidate(source: SourceObservation, id: string): DedupeCandidate {
  return {
    candidateId: id,
    observationId: source.observationId,
    providerId: "greenhouse",
    sourceRecordId: id,
    canonicalUrl: `https://jobs.example.test/${id}`,
    applyUrl: `https://apply.example.test/${id}`,
    company: "Synthetic Career Lab",
    companyDomain: "example.test",
    roleTitle: "Career Safety Engineer",
    location: "Remote, Europe",
    postedAt: OBSERVED_AT,
    descriptionDigest: sha256(`description:${id}`),
    taxonomyConceptIds: ["esco:2512.1"]
  };
}

function taxonomyFixtures() {
  const esco = createTaxonomySnapshot({
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
    concepts: [{
      conceptId: "esco:2512.1",
      code: "2512.1",
      preferredLabel: "Artificial intelligence engineer",
      language: "en",
      alternateLabels: ["AI engineer"],
      description: "Designs artificial intelligence systems.",
      skillIds: ["esco:skill:machine-learning"]
    }]
  });
  const onet = createTaxonomySnapshot({
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
    concepts: [{
      conceptId: "onet:15-2051.00",
      code: "15-2051.00",
      preferredLabel: "Data Scientists",
      language: "en",
      alternateLabels: ["Artificial Intelligence Engineer"],
      description: "Develops analytical systems.",
      skillIds: ["onet:skill:programming"]
    }]
  });
  const mappings = createTaxonomyMappingSet({
    mappingVersion: "2026.07",
    createdAt: "2026-07-14T10:10:00.000Z",
    fromSnapshot: esco,
    toSnapshot: onet,
    entries: [{
      fromConceptId: "esco:2512.1",
      toConceptId: "onet:15-2051.00",
      relation: "close",
      confidence: 0.92,
      method: "curated",
      evidence: [{
        sourceUrl: "https://example.test/taxonomy/crosswalk",
        retrievedAt: "2026-07-14T10:09:00.000Z",
        note: "Synthetic curated crosswalk fixture."
      }]
    }]
  });
  return { esco, onet, mappings };
}

function assuranceCase() {
  return createCareerAssuranceCase({
    caseId: "CASE-STORAGE-001",
    createdAt: "2026-07-14T12:00:00.000Z",
    decision: {
      decisionId: "DECISION-STORAGE-001",
      routeId: "ROUTE-STORAGE-001",
      recommendation: "defer",
      statement: "Defer the consequential action until the evidence review is complete.",
      reversibility: "R1",
      highStakes: false,
      disclosure: "public"
    },
    evidence: [{
      evidenceId: "EVIDENCE-STORAGE-001",
      claimId: "CLAIM-STORAGE-001",
      claimHash: sha256("claim"),
      sourceId: "fixture:decision-intelligence",
      sourceHash: sha256("source"),
      observedAt: "2026-07-14T11:00:00.000Z",
      freshUntil: "2026-07-15T11:00:00.000Z",
      disclosure: "public"
    }],
    uncertainties: [],
    defeaters: [],
    policies: [{
      policyId: "POLICY-STORAGE-001",
      policyVersionHash: sha256("policy"),
      outcome: "allow",
      rationale: "The defer recommendation preserves reversibility.",
      evaluatedAt: "2026-07-14T12:00:00.000Z",
      disclosure: "public"
    }],
    approvals: [],
    receipts: [],
    versions: {
      modelHash: sha256("model"),
      policySetHash: sha256("policy-set"),
      taxonomyHash: sha256("taxonomy"),
      dataSnapshotHash: sha256("data"),
      generatorBuildHash: sha256("generator")
    },
    generator: {
      principalId: "GENERATOR-STORAGE",
      componentId: "assurance-generator",
      generatedAt: "2026-07-14T12:00:00.000Z"
    }
  }, NOW);
}

function check(code: string, status: CredentialCheck["status"] = "pass"): CredentialCheck {
  return { status, code, checkedAt: NOW.toISOString(), details: [] };
}

function credentialPassport(): CredentialPassportEntry {
  const credential: JsonObject = {
    id: "https://issuer.example/credentials/storage-1",
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: "https://issuer.example/profiles/1",
    credentialSubject: {
      id: "did:example:holder-storage",
      achievement: {
        id: "https://issuer.example/achievements/storage",
        name: "Decision Intelligence"
      }
    }
  };
  const originalHash = sha256("credential original bytes");
  return {
    schemaVersion: 1,
    passportEntryId: `CREDENTIAL-${originalHash.slice("sha256:".length).toUpperCase()}`,
    importedAt: NOW.toISOString(),
    original: {
      hash: originalHash,
      byteLength: 25,
      format: "json",
      mediaType: "application/json"
    },
    envelopeFormat: "json",
    canonicalCredentialHash: sha256(stableStringify(credential)),
    credential,
    summary: {
      credentialId: "https://issuer.example/credentials/storage-1",
      issuerId: "https://issuer.example/profiles/1",
      subjectId: "did:example:holder-storage",
      achievementId: "https://issuer.example/achievements/storage",
      achievementName: "Decision Intelligence",
      validFrom: "2026-07-14T10:00:00.000Z",
      validUntil: "2027-07-14T10:00:00.000Z"
    },
    verification: {
      schema: check("schema-valid"),
      signature: check("signature-valid"),
      issuer: check("issuer-valid"),
      subject: check("subject-valid"),
      time: check("time-valid"),
      revocation: check("not-revoked"),
      refresh: check("refresh-not-applicable", "not-applicable"),
      overall: "verified",
      eligibleForMapping: true
    },
    mappings: []
  };
}

describe("decision intelligence event-sourced repositories", () => {
  let root: string;
  let databasePath: string;
  let store: EncryptedEventStore;
  let repositories: DecisionIntelligenceRepositories;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-decision-intelligence-"));
    databasePath = path.join(root, "vocation.db");
    store = await EncryptedEventStore.open(databasePath, PASSPHRASE);
    repositories = new DecisionIntelligenceRepositories(store);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists all nine domains through dedicated typed methods and authority receipts", async () => {
    const source = observation();
    const truth = opportunityTruth(source);
    const liveness = assessSourceLiveness([source], DEFAULT_LIVENESS_POLICY, NOW);
    const dedupe = deduplicateCandidates([candidate(source, "candidate-A")]);
    const taxonomy = taxonomyFixtures();
    const assurance = assuranceCase();
    const passport = credentialPassport();
    const mapping = createCredentialClaimMapping(passport, {
      mappingId: "MAPPING-STORAGE-001",
      claimType: "credential",
      claimText: "Earned the synthetic Decision Intelligence credential."
    });

    const records = [
      await repositories.recordSourceObservation({ value: source, expectedVersion: 0, authorityRequestId: requestId(1), now: NOW }),
      await repositories.recordOpportunityTruth({ value: truth, expectedVersion: 0, authorityRequestId: requestId(2), now: NOW }),
      await repositories.recordLivenessAssessment({ value: liveness, expectedVersion: 0, authorityRequestId: requestId(3), now: NOW }),
      await repositories.recordDedupeResult({ value: dedupe, expectedVersion: 0, authorityRequestId: requestId(4), now: NOW }),
      await repositories.recordTaxonomySnapshot({ value: taxonomy.esco, expectedVersion: 0, authorityRequestId: requestId(5), now: NOW }),
      await repositories.recordTaxonomyMappingSet({ value: taxonomy.mappings, expectedVersion: 0, authorityRequestId: requestId(6), now: NOW }),
      await repositories.recordCareerAssuranceCase({ value: assurance, expectedVersion: 0, authorityRequestId: requestId(7), now: NOW }),
      await repositories.recordCredentialPassport({ value: passport, expectedVersion: 0, authorityRequestId: requestId(8), now: NOW }),
      await repositories.recordCredentialMappingPlan({ value: mapping, expectedVersion: 0, authorityRequestId: requestId(9), now: NOW })
    ];

    expect(records.map((record) => record.domain)).toEqual(DECISION_INTELLIGENCE_DOMAINS);
    expect(records.every((record) => record.version === 1)).toBe(true);
    expect(await repositories.getSourceObservation(source.observationId)).toEqual(records[0]);
    expect(await repositories.getOpportunityTruth(truth.truthRecordId)).toEqual(records[1]);
    expect(await repositories.getLivenessAssessment(liveness.assessmentId)).toEqual(records[2]);
    expect(await repositories.getDedupeResult(dedupe.resultId)).toEqual(records[3]);
    expect(await repositories.getTaxonomySnapshot(taxonomy.esco.snapshotId)).toEqual(records[4]);
    expect(await repositories.getTaxonomyMappingSet(taxonomy.mappings.mappingSetId)).toEqual(records[5]);
    expect(await repositories.getCareerAssuranceCase(assurance.caseId)).toEqual(records[6]);
    expect(await repositories.getCredentialPassport(passport.passportEntryId)).toEqual(records[7]);
    expect(await repositories.getCredentialMappingPlan(mapping.mappingId)).toEqual(records[8]);
    expect(await repositories.listSourceObservations()).toEqual([records[0]]);
    expect(await repositories.listOpportunityTruthRecords()).toEqual([records[1]]);
    expect(await repositories.listLivenessAssessments()).toEqual([records[2]]);
    expect(await repositories.listDedupeResults()).toEqual([records[3]]);
    expect(await repositories.listTaxonomySnapshots()).toEqual([records[4]]);
    expect(await repositories.listTaxonomyMappingSets()).toEqual([records[5]]);
    expect(await repositories.listCareerAssuranceCases()).toEqual([records[6]]);
    expect(await repositories.listCredentialPassports()).toEqual([records[7]]);
    expect(await repositories.listCredentialMappingPlans()).toEqual([records[8]]);

    for (const record of records) {
      const receipt = store.findAuthorityReceipt(record.authority.requestId);
      expect(receipt).toMatchObject({
        requestHash: record.authority.requestHash,
        operation: record.authority.operation,
        responseHash: sha256(stableStringify(record))
      });
    }
    expect((await store.verifyIntegrity()).eventCount).toBe(9);
    expect("put" in repositories).toBe(false);
    expect("repository" in repositories).toBe(false);
  });

  it("enforces idempotent replay and optimistic concurrency without duplicate events", async () => {
    const source = observation();
    const command = {
      value: source,
      expectedVersion: 0,
      authorityRequestId: requestId(20),
      now: NOW
    };
    const [first, replay] = await Promise.all([
      repositories.recordSourceObservation(command),
      repositories.recordSourceObservation({ ...command, now: new Date(NOW.getTime() + 10_000) })
    ]);
    expect(replay).toEqual(first);
    expect((await store.chainHead()).eventCount).toBe(1);

    await expect(repositories.recordSourceObservation({
      ...command,
      value: observation("greenhouse:job-43")
    })).rejects.toThrow("reused with different parameters");

    const passport = credentialPassport();
    await repositories.recordCredentialPassport({
      value: passport,
      expectedVersion: 0,
      authorityRequestId: requestId(21),
      now: NOW
    });
    const second = await repositories.recordCredentialPassport({
      value: passport,
      expectedVersion: 1,
      authorityRequestId: requestId(22),
      now: new Date(NOW.getTime() + 1_000)
    });
    expect(second.version).toBe(2);
    await expect(repositories.recordCredentialPassport({
      value: passport,
      expectedVersion: 1,
      authorityRequestId: requestId(23),
      now: new Date(NOW.getTime() + 2_000)
    })).rejects.toThrow("version conflict");
    expect((await store.chainHead()).eventCount).toBe(3);
  });

  it("fails closed when independent repository instances race on one aggregate version", async () => {
    const competing = new DecisionIntelligenceRepositories(store);
    const passport = credentialPassport();
    const results = await Promise.allSettled([
      repositories.recordCredentialPassport({
        value: passport,
        expectedVersion: 0,
        authorityRequestId: requestId(24),
        now: NOW
      }),
      competing.recordCredentialPassport({
        value: passport,
        expectedVersion: 0,
        authorityRequestId: requestId(25),
        now: NOW
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await store.chainHead()).eventCount).toBe(1);
    expect(await repositories.listCredentialPassports()).toHaveLength(1);
  });

  it("recovers an authority receipt from its deterministic authenticated event", async () => {
    const taxonomy = taxonomyFixtures().esco;
    const command = {
      value: taxonomy,
      expectedVersion: 0,
      authorityRequestId: requestId(30),
      now: NOW
    };
    const original = await repositories.recordTaxonomySnapshot(command);
    const sqlite = new BetterSqlite3(databasePath);
    try {
      sqlite.prepare("DELETE FROM authority_receipts WHERE request_id = ?").run(command.authorityRequestId);
    } finally {
      sqlite.close();
    }
    expect(store.findAuthorityReceipt(command.authorityRequestId)).toBeNull();

    const recovered = await repositories.recordTaxonomySnapshot({
      ...command,
      now: new Date(NOW.getTime() + 60_000)
    });
    expect(recovered).toEqual(original);
    expect(store.findAuthorityReceipt(command.authorityRequestId)).toMatchObject({
      eventId: expect.stringMatching(/^EVT-CMD-[a-f0-9]{64}$/),
      responseHash: sha256(stableStringify(original))
    });
    expect((await store.chainHead()).eventCount).toBe(1);

    const tamper = new BetterSqlite3(databasePath);
    try {
      tamper.prepare("UPDATE authority_receipts SET completed_at = ? WHERE request_id = ?")
        .run("2026-07-14T12:31:00.000Z", command.authorityRequestId);
    } finally {
      tamper.close();
    }
    await expect(repositories.recordTaxonomySnapshot(command))
      .rejects.toThrow("authority receipt binding is invalid");
    expect((await store.chainHead()).eventCount).toBe(1);
  });

  it("fails closed on malformed values, request identities, and authenticated history", async () => {
    const source = observation();
    await expect(repositories.recordSourceObservation({
      value: { ...source, observationId: `OBS-${"0".repeat(32)}` },
      expectedVersion: 0,
      authorityRequestId: requestId(40),
      now: NOW
    })).rejects.toThrow(/integrity check failed/);

    const passport = credentialPassport();
    await expect(repositories.recordCredentialPassport({
      value: { ...passport, canonicalCredentialHash: sha256("forged") },
      expectedVersion: 0,
      authorityRequestId: requestId(41),
      now: NOW
    })).rejects.toThrow("canonical hash is invalid");

    await expect(repositories.recordSourceObservation({
      value: source,
      expectedVersion: 0,
      authorityRequestId: "invalid-request",
      now: NOW
    })).rejects.toThrow("authority request id is invalid");

    const malformedId = `OBS-${"F".repeat(32)}`;
    await store.append({
      aggregateType: "decision-source-observations",
      aggregateId: malformedId,
      eventType: "decision-intelligence-record-put",
      schemaVersion: 1,
      occurredAt: NOW,
      payload: { record: null }
    });
    await expect(repositories.getSourceObservation(malformedId)).rejects.toThrow("event payload is malformed");
  });

  it("rejects hidden object state before canonical hashing", async () => {
    const passport = credentialPassport();
    Object.defineProperty(passport.credential, "hidden", {
      value: "not part of JSON",
      enumerable: false
    });
    await expect(repositories.recordCredentialPassport({
      value: passport,
      expectedVersion: 0,
      authorityRequestId: requestId(50),
      now: NOW
    })).rejects.toThrow("accessors or hidden properties");
  });

  it("sorts list results by canonical record identity", async () => {
    const first = observation("greenhouse:job-91");
    const second = observation("greenhouse:job-90");
    await repositories.recordSourceObservation({
      value: first,
      expectedVersion: 0,
      authorityRequestId: requestId(60),
      now: NOW
    });
    await repositories.recordSourceObservation({
      value: second,
      expectedVersion: 0,
      authorityRequestId: requestId(61),
      now: NOW
    });
    const listed = await repositories.listSourceObservations();
    expect(listed.map((record) => record.recordId)).toEqual(
      [first.observationId, second.observationId].sort()
    );
  });

  it("rejects malformed command clocks, versions, and canonical JSON containers", async () => {
    const source = observation();
    await expect(repositories.recordSourceObservation({
      value: source,
      expectedVersion: -1,
      authorityRequestId: requestId(70),
      now: NOW
    })).rejects.toThrow("expected version");
    await expect(repositories.recordSourceObservation({
      value: source,
      expectedVersion: 0,
      authorityRequestId: requestId(71),
      now: new Date(Number.NaN)
    })).rejects.toThrow("operation time is invalid");

    const withPrototype = credentialPassport();
    withPrototype.credential = new Date() as unknown as JsonObject;
    await expect(repositories.recordCredentialPassport({
      value: withPrototype,
      expectedVersion: 0,
      authorityRequestId: requestId(72),
      now: NOW
    })).rejects.toThrow("plain JSON objects");

    const withSparseArray = credentialPassport();
    withSparseArray.mappings = new Array<CredentialClaimMapping>(1);
    await expect(repositories.recordCredentialPassport({
      value: withSparseArray,
      expectedVersion: 0,
      authorityRequestId: requestId(73),
      now: NOW
    })).rejects.toThrow("sparse or extended arrays");

    expect(await repositories.getSourceObservation(source.observationId)).toBeNull();
    expect(await repositories.listSourceObservations()).toEqual([]);
  });

  it("rejects inconsistent credential mapping authority and passport state", async () => {
    const passport = credentialPassport();
    const pending = createCredentialClaimMapping(passport, {
      mappingId: "MAPPING-SEMANTIC-001",
      claimType: "credential",
      claimText: "Earned the synthetic Decision Intelligence credential."
    });
    await expect(repositories.recordCredentialMappingPlan({
      value: { ...pending, mappingHash: sha256("forged-mapping") },
      expectedVersion: 0,
      authorityRequestId: requestId(80),
      now: NOW
    })).rejects.toThrow("mapping plan hash is invalid");

    const automaticWithoutPublic: CredentialClaimMapping = {
      ...pending,
      requestedAutoApply: true,
      mappingHash: ""
    };
    automaticWithoutPublic.mappingHash = computeCredentialMappingHash(automaticWithoutPublic);
    await expect(repositories.recordCredentialMappingPlan({
      value: automaticWithoutPublic,
      expectedVersion: 0,
      authorityRequestId: requestId(81),
      now: NOW
    })).rejects.toThrow("automatic use requires public review");

    await expect(repositories.recordCredentialMappingPlan({
      value: { ...pending, publiclyAssertable: true },
      expectedVersion: 0,
      authorityRequestId: requestId(82),
      now: NOW
    })).rejects.toThrow("Pending credential mapping plans cannot carry approved permissions");

    await expect(repositories.recordCredentialMappingPlan({
      value: { ...pending, status: "approved" },
      expectedVersion: 0,
      authorityRequestId: requestId(83),
      now: NOW
    })).rejects.toThrow("require an approval");

    const requested = createCredentialClaimMapping(passport, {
      mappingId: "MAPPING-SEMANTIC-002",
      claimType: "credential",
      claimText: "Earned the synthetic Decision Intelligence credential.",
      requestedPublic: true
    });
    const invalidWindow: CredentialClaimMapping = {
      ...requested,
      status: "approved",
      publiclyAssertable: true,
      approval: {
        approvalId: "APPROVAL-SEMANTIC-001",
        approverPrincipalId: "HUMAN-APPROVER",
        approvedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 25 * 60 * 60_000).toISOString(),
        mappingHash: requested.mappingHash,
        allowPublic: true,
        allowAutoApply: false,
        signatureReceiptHash: sha256("approval")
      }
    };
    await expect(repositories.recordCredentialMappingPlan({
      value: invalidWindow,
      expectedVersion: 0,
      authorityRequestId: requestId(84),
      now: NOW
    })).rejects.toThrow("approval window is invalid");

    await expect(repositories.recordCredentialPassport({
      value: { ...passport, passportEntryId: `CREDENTIAL-${"0".repeat(64)}` },
      expectedVersion: 0,
      authorityRequestId: requestId(85),
      now: NOW
    })).rejects.toThrow("id is not bound");
    await expect(repositories.recordCredentialPassport({
      value: {
        ...passport,
        verification: { ...passport.verification, overall: "incomplete" }
      },
      expectedVersion: 0,
      authorityRequestId: requestId(86),
      now: NOW
    })).rejects.toThrow("mapping eligibility requires verified status");
    await expect(repositories.recordCredentialPassport({
      value: {
        ...passport,
        verification: {
          ...passport.verification,
          signature: check("signature-invalid", "fail")
        }
      },
      expectedVersion: 0,
      authorityRequestId: requestId(87),
      now: NOW
    })).rejects.toThrow("non-verifying check");
    await expect(repositories.recordCredentialPassport({
      value: { ...passport, mappings: [pending] },
      expectedVersion: 0,
      authorityRequestId: requestId(88),
      now: NOW
    })).rejects.toThrow("only approved mappings");
  });

  it("rejects tampered taxonomy and assurance integrity before appending", async () => {
    const taxonomy = taxonomyFixtures();
    await expect(repositories.recordTaxonomySnapshot({
      value: { ...taxonomy.esco, contentHash: sha256("tampered") } as TaxonomySnapshot,
      expectedVersion: 0,
      authorityRequestId: requestId(90),
      now: NOW
    })).rejects.toThrow("Taxonomy snapshot validation failed");
    await expect(repositories.recordTaxonomyMappingSet({
      value: { ...taxonomy.mappings, contentHash: sha256("tampered") },
      expectedVersion: 0,
      authorityRequestId: requestId(91),
      now: NOW
    })).rejects.toThrow("Taxonomy mapping set validation failed");

    const assurance = assuranceCase();
    await expect(repositories.recordCareerAssuranceCase({
      value: { ...assurance, caseHash: sha256("tampered") },
      expectedVersion: 0,
      authorityRequestId: requestId(92),
      now: NOW
    })).rejects.toThrow("integrity validation failed");
    expect((await store.chainHead()).eventCount).toBe(0);
  });
});
