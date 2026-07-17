import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { providerManifestById } from "../../src/discovery/providers.js";
import { createSourceObservation } from "../../src/discovery/source-observation.js";
import { deriveDiscoveryPosting } from "../../src/discovery/discovery-records.js";
import type { DiscoveredProviderPosting } from "../../src/discovery/provider-adapters.js";
import { deduplicateCandidates, type DedupeCandidate } from "../../src/discovery/dedupe.js";
import { sha256 } from "../../src/hash.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import { ArtifactVault, generateArtifactVaultKey } from "../../src/storage/artifact-vault.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { createTaxonomySnapshot } from "../../src/taxonomy/index.js";
import {
  OPEN_BADGES_CONTEXT_URL,
  VC_CONTEXT_URL,
  validateCredentialPassportExport
} from "../../src/credentials/index.js";

const PASSPHRASE = "decision intelligence authority passphrase";
const NOW = new Date("2026-07-14T12:30:00.000Z");

describe("decision intelligence daemon authority", () => {
  let root: string;
  let store: EncryptedEventStore;
  let authority: RuntimeAuthority;
  let artifactVault: ArtifactVault;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-decision-authority-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), PASSPHRASE);
    artifactVault = new ArtifactVault({
      rootPath: path.join(root, "artifacts"),
      masterKey: generateArtifactVaultKey()
    });
    authority = new RuntimeAuthority(store, new MemoryCredentialStore(), root, artifactVault);
  });

  afterEach(async () => {
    artifactVault.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("records, replays, gets, and lists an observation through dedicated operations", async () => {
    const sourceUrl = "https://boards-api.greenhouse.io/v1/boards/example/jobs/42";
    const observation = createSourceObservation({
      providerId: "greenhouse",
      providerManifestVersion: providerManifestById("greenhouse").egress.version,
      sourceKey: "greenhouse:job-42",
      requestedUrl: sourceUrl,
      finalUrl: sourceUrl,
      observedAt: "2026-07-14T12:00:00.000Z",
      availability: "available",
      httpStatus: 200,
      contentType: "application/json",
      bodyDigest: sha256("governed observation body"),
      cacheState: "bypass",
      redirectCount: 0,
      fields: [{
        field: "roleTitle",
        value: "Career Safety Engineer",
        confidence: "high",
        evidencePointer: "$.title"
      }],
      uncertainty: []
    });
    const command = {
      id: "REQ-SOURCE-OBSERVATION-0001",
      operation: "source-observation-record" as const,
      payload: { value: observation, expectedVersion: 0 }
    };

    const first = await authority.execute(command, NOW);
    const replay = await authority.execute(command, new Date(NOW.getTime() + 60_000));
    expect(replay).toEqual(first);
    expect(await authority.execute({
      id: "REQ-SOURCE-OBSERVATION-GET-0001",
      operation: "source-observation-get",
      payload: { recordId: observation.observationId }
    })).toEqual(first);
    expect(await authority.execute({
      id: "REQ-SOURCE-OBSERVATION-LIST-0001",
      operation: "source-observation-list",
      payload: {}
    })).toMatchObject({
      items: [{
        domain: "source-observations",
        recordId: observation.observationId,
        version: 1
      }],
      nextCursor: null,
      limit: 50,
      pageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    expect((await store.chainHead()).eventCount).toBe(1);
    expect(store.findAuthorityReceipt(command.id)).toMatchObject({
      operation: command.operation
    });

    const sqlite = new BetterSqlite3(store.path());
    try {
      sqlite.prepare("UPDATE authority_receipts SET completed_at = ? WHERE request_id = ?")
        .run("2026-07-14T12:31:00.000Z", command.id);
    } finally {
      sqlite.close();
    }
    await expect(authority.execute(command, NOW)).rejects.toThrow("authority receipt binding is invalid");
  });

  it("rejects request id reuse, extra payload fields, and version conflicts", async () => {
    const sourceUrl = "https://jobs.example.test/roles/42";
    const observation = createSourceObservation({
      providerId: "schema-org-job-posting",
      providerManifestVersion: providerManifestById("schema-org-job-posting").egress.version,
      sourceKey: "schema-org:job-42",
      requestedUrl: sourceUrl,
      finalUrl: sourceUrl,
      observedAt: "2026-07-14T12:00:00.000Z",
      availability: "available",
      httpStatus: 200,
      contentType: "text/html",
      bodyDigest: sha256("governed html"),
      cacheState: "bypass",
      redirectCount: 0,
      fields: [],
      uncertainty: []
    });
    await authority.execute({
      id: "REQ-SOURCE-OBSERVATION-0002",
      operation: "source-observation-record",
      payload: { value: observation, expectedVersion: 0 }
    }, NOW);

    await expect(authority.execute({
      id: "REQ-SOURCE-OBSERVATION-0002",
      operation: "source-observation-record",
      payload: { value: { ...observation, sourceKey: "schema-org:job-43" }, expectedVersion: 0 }
    }, NOW)).rejects.toThrow("request id was reused with different parameters");
    await expect(authority.execute({
      id: "REQ-SOURCE-OBSERVATION-EXTRA",
      operation: "source-observation-record",
      payload: { value: observation, expectedVersion: 1, bypass: true }
    }, NOW)).rejects.toThrow("must contain exactly");
    await expect(authority.execute({
      id: "REQ-SOURCE-OBSERVATION-0003",
      operation: "source-observation-record",
      payload: { value: observation, expectedVersion: 0 }
    }, NOW)).rejects.toThrow("version conflict");
  });

  it("serves a bounded discovery review projection joined inside vocationd", async () => {
    const endpoint = createSourceObservation({
      providerId: "greenhouse",
      providerManifestVersion: providerManifestById("greenhouse").egress.version,
      sourceKey: "greenhouse:review-board",
      requestedUrl: "https://boards-api.greenhouse.io/v1/boards/review/jobs",
      finalUrl: "https://boards-api.greenhouse.io/v1/boards/review/jobs",
      observedAt: "2026-07-14T12:00:00.000Z",
      availability: "available",
      httpStatus: 200,
      contentType: "application/json",
      bodyDigest: sha256("review fixture"),
      cacheState: "bypass",
      redirectCount: 0,
      fields: [],
      uncertainty: []
    });
    const posting: DiscoveredProviderPosting = {
      postingId: "POST-REVIEW-42",
      providerId: "greenhouse",
      sourceRecordId: "review-42",
      sourceUrl: endpoint.finalUrl ?? endpoint.requestedUrl,
      canonicalUrl: "https://boards.greenhouse.io/review/jobs/42",
      applyUrl: "https://boards.greenhouse.io/review/jobs/42#apply",
      company: "Evidence Lab",
      roleTitle: "Career Decision Scientist",
      location: "Remote, Europe",
      descriptionText: "Build evidence grounded career decision systems.",
      postedAt: "2026-07-13T12:00:00.000Z",
      deadline: null,
      capturedAt: endpoint.observedAt,
      sourcePayloadHash: sha256("review posting")
    };
    const derived = deriveDiscoveryPosting(posting, endpoint);
    await authority.execute({
      id: "REQ-REVIEW-OPPORTUNITY-0001",
      operation: "domain-put",
      payload: { domain: "opportunities", value: derived.opportunity, expectedVersion: 0 }
    }, NOW);
    await authority.execute({
      id: "REQ-REVIEW-LIVENESS-0001",
      operation: "liveness-assessment-record",
      payload: { value: derived.liveness, expectedVersion: 0 }
    }, NOW);
    await authority.execute({
      id: "REQ-REVIEW-TRUTH-0001",
      operation: "opportunity-truth-record",
      payload: { value: derived.truth, expectedVersion: 0 }
    }, NOW);

    const page = await authority.execute({
      id: "REQ-REVIEW-LIST-0001",
      operation: "discovery-review-list",
      payload: { cursor: null, limit: 10 }
    }, NOW);
    expect(page).toMatchObject({
      limit: 10,
      nextCursor: null,
      pageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      items: [{
        opportunityId: derived.opportunity.opportunityId,
        providerId: "greenhouse",
        liveness: "live",
        truthDisposition: "blocked",
        status: "blocked",
        duplicateStatus: "unassessed",
        evidenceRecordIds: expect.arrayContaining([derived.liveness.assessmentId, derived.truth.truthRecordId])
      }]
    });
    expect(JSON.stringify(page)).not.toContain(derived.opportunity.descriptionText);
  });

  it("preserves the most cautious result across every dedupe relation in the latest run", async () => {
    const endpoint = createSourceObservation({
      providerId: "greenhouse",
      providerManifestVersion: providerManifestById("greenhouse").egress.version,
      sourceKey: "greenhouse:dedupe-review-board",
      requestedUrl: "https://boards-api.greenhouse.io/v1/boards/dedupe-review/jobs",
      finalUrl: "https://boards-api.greenhouse.io/v1/boards/dedupe-review/jobs",
      observedAt: "2026-07-14T12:00:00.000Z",
      availability: "available",
      httpStatus: 200,
      contentType: "application/json",
      bodyDigest: sha256("dedupe review fixture"),
      cacheState: "bypass",
      redirectCount: 0,
      fields: [],
      uncertainty: []
    });
    const posting: DiscoveredProviderPosting = {
      postingId: "POST-DEDUPE-REVIEW-42",
      providerId: "greenhouse",
      sourceRecordId: "dedupe-review-42",
      sourceUrl: endpoint.finalUrl ?? endpoint.requestedUrl,
      canonicalUrl: "https://boards.greenhouse.io/dedupe-review/jobs/42",
      applyUrl: "https://boards.greenhouse.io/dedupe-review/jobs/42#apply",
      company: "Evidence Lab",
      roleTitle: "Career Decision Scientist",
      location: "Remote, Europe",
      descriptionText: "Build evidence grounded career decision systems.",
      postedAt: "2026-07-13T12:00:00.000Z",
      deadline: null,
      capturedAt: endpoint.observedAt,
      sourcePayloadHash: sha256("dedupe review posting")
    };
    const derived = deriveDiscoveryPosting(posting, endpoint);
    await authority.execute({
      id: "REQ-DEDUPE-REVIEW-OPPORTUNITY-0001",
      operation: "domain-put",
      payload: { domain: "opportunities", value: derived.opportunity, expectedVersion: 0 }
    }, NOW);

    const candidates: readonly DedupeCandidate[] = [{
      candidateId: derived.opportunity.opportunityId,
      observationId: "OBS-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      providerId: "greenhouse",
      sourceRecordId: "dedupe-primary",
      canonicalUrl: "https://jobs.example.test/roles/primary",
      applyUrl: null,
      company: "Evidence Lab",
      companyDomain: "evidence.example",
      roleTitle: "Career Decision Scientist",
      location: "Remote, Europe",
      postedAt: null,
      descriptionDigest: null
    }, {
      candidateId: "OPP-DEDUPE-RELATED",
      observationId: "OBS-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      providerId: "lever",
      sourceRecordId: "dedupe-related",
      canonicalUrl: "https://jobs.example.test/roles/related",
      applyUrl: null,
      company: "Evidence Lab",
      companyDomain: "evidence.example",
      roleTitle: "Career Decision Scientist",
      location: "Remote, Europe",
      postedAt: null,
      descriptionDigest: null
    }, {
      candidateId: "OPP-DEDUPE-DISTINCT",
      observationId: "OBS-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      providerId: "ashby",
      sourceRecordId: "dedupe-distinct",
      canonicalUrl: "https://jobs.other.test/roles/distinct",
      applyUrl: null,
      company: "Other Lab",
      companyDomain: "other.example",
      roleTitle: "Finance Director",
      location: "On site, New York",
      postedAt: null,
      descriptionDigest: null
    }];
    const dedupe = deduplicateCandidates(candidates);
    expect(dedupe.decisions.filter((decision) =>
      decision.leftCandidateId === derived.opportunity.opportunityId
      || decision.rightCandidateId === derived.opportunity.opportunityId
    ).map((decision) => decision.outcome).sort()).toEqual(["distinct", "review"]);
    await authority.execute({
      id: "REQ-DEDUPE-REVIEW-RESULT-0001",
      operation: "dedupe-result-record",
      payload: { value: dedupe, expectedVersion: 0 }
    }, NOW);

    const page = await authority.execute({
      id: "REQ-DEDUPE-REVIEW-LIST-0001",
      operation: "discovery-review-list",
      payload: { cursor: null, limit: 10 }
    }, NOW) as { items: Array<Record<string, unknown>> };
    expect(page.items[0]).toMatchObject({
      opportunityId: derived.opportunity.opportunityId,
      duplicateStatus: "review",
      duplicateCandidateIds: ["OPP-DEDUPE-DISTINCT", "OPP-DEDUPE-RELATED"],
      status: "needs_review"
    });
  });

  it("imports a taxonomy artifact and queries it without returning the full snapshot", async () => {
    const snapshot = createTaxonomySnapshot({
      source: "esco",
      version: "1.2.0",
      completeness: "partial",
      sourceUrl: "https://esco.ec.europa.eu/en/classification/occupation_main",
      retrievedAt: "2026-07-14T12:00:00.000Z",
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
        alternateLabels: ["AI engineer"]
      }]
    });
    const sourcePath = path.join(root, "esco.json");
    writeFileSync(sourcePath, JSON.stringify(snapshot), "utf8");
    const manifest = await authority.execute({
      id: "REQ-TAXONOMY-ARTIFACT-IMPORT-0001",
      operation: "artifact-import",
      payload: { sourcePath }
    }, NOW);
    const command = {
      id: "REQ-TAXONOMY-SNAPSHOT-IMPORT-0001",
      operation: "taxonomy-snapshot-import-artifact" as const,
      payload: { manifest, expectedVersion: 0 }
    };
    const first = await authority.execute(command, NOW);
    expect(first).toMatchObject({
      record: { recordId: snapshot.snapshotId, version: 1 },
      snapshot: { conceptCount: 1, contentHash: snapshot.contentHash },
      artifact: manifest
    });
    expect(JSON.stringify(first)).not.toContain("Artificial intelligence engineer");
    await expect(authority.execute(command, new Date(NOW.getTime() + 60_000))).resolves.toEqual(first);

    await expect(authority.execute({
      id: "REQ-TAXONOMY-QUERY-0001",
      operation: "taxonomy-query",
      payload: {
        snapshotId: snapshot.snapshotId,
        queries: ["AI engineer"],
        limit: 5,
        minimumScore: 0.25
      }
    }, NOW)).resolves.toMatchObject({
      snapshotId: snapshot.snapshotId,
      matches: [{ results: [{ conceptId: "esco:2512.1", score: 1 }] }]
    });
  });

  it("imports a credential only from a manifest bound encrypted artifact", async () => {
    const credential = {
      "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL],
      id: "https://issuer.example/credentials/credential-1",
      type: ["VerifiableCredential", "OpenBadgeCredential"],
      issuer: { id: "https://issuer.example/profiles/issuer-1" },
      validFrom: "2026-07-14T10:00:00.000Z",
      credentialSubject: {
        id: "did:example:holder-1",
        achievement: {
          id: "https://issuer.example/achievements/credential-1",
          name: "Evidence grounded decision practice",
          criteria: { narrative: "Completed the stated assessment." }
        }
      }
    };
    const sourcePath = path.join(root, "credential.json");
    writeFileSync(sourcePath, JSON.stringify(credential), "utf8");
    const manifest = await authority.execute({
      id: "REQ-CREDENTIAL-ARTIFACT-IMPORT-0001",
      operation: "artifact-import",
      payload: { sourcePath }
    }, NOW);
    const result = await authority.execute({
      id: "REQ-CREDENTIAL-PASSPORT-IMPORT-0001",
      operation: "credential-import-artifact",
      payload: {
        manifest,
        format: "json",
        expectedSubjectId: "did:example:holder-1",
        importedAt: NOW.toISOString(),
        expectedVersion: 0
      }
    }, NOW);
    expect(result).toMatchObject({
      record: { version: 1 },
      passport: {
        verification: { overall: "incomplete", eligibleForMapping: false }
      },
      artifact: manifest
    });
    const passportId = (result as {
      passport: { passportEntryId: string };
    }).passport.passportEntryId;
    const exportCommand = {
      id: "REQ-CREDENTIAL-PASSPORT-EXPORT-0001",
      operation: "credential-export-artifact" as const,
      payload: { passportId, exportedAt: NOW.toISOString() }
    };
    const generated = await authority.execute(exportCommand, NOW) as {
      packageHash: string;
      artifact: { contentHash: string; sizeBytes: number };
      record: { recordId: string; version: number };
    };
    expect(generated).toMatchObject({
      packageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      record: { recordId: passportId, version: 1 },
      artifact: { contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }
    });
    expect(JSON.stringify(generated)).not.toContain("Evidence grounded decision practice");

    const exportRoot = path.join(root, "exports");
    mkdirSync(exportRoot);
    const outputPath = path.join(exportRoot, "credential.vocationpass");
    const writeCommand = {
      id: "REQ-CREDENTIAL-PASSPORT-WRITE-0001",
      operation: "artifact-export" as const,
      payload: { manifest: generated.artifact, outputPath }
    };
    const firstWrite = await authority.execute(writeCommand, NOW);
    expect(firstWrite).toMatchObject({
      outputPath,
      contentHash: generated.artifact.contentHash,
      sizeBytes: generated.artifact.sizeBytes,
      recoveredExisting: false
    });
    const exported = validateCredentialPassportExport(JSON.parse(readFileSync(outputPath, "utf8")) as unknown);
    expect(exported.checksums.package).toBe(generated.packageHash);

    await expect(authority.execute({
      ...writeCommand,
      id: "REQ-CREDENTIAL-PASSPORT-WRITE-RECOVER-0001"
    }, new Date(NOW.getTime() + 30_000))).resolves.toMatchObject({
      outputPath,
      contentHash: generated.artifact.contentHash,
      sizeBytes: generated.artifact.sizeBytes,
      recoveredExisting: true
    });

    rmSync(outputPath);
    await expect(authority.execute(writeCommand, new Date(NOW.getTime() + 60_000))).resolves.toEqual(firstWrite);
    expect(validateCredentialPassportExport(JSON.parse(readFileSync(outputPath, "utf8")) as unknown)
      .checksums.package).toBe(generated.packageHash);
    writeFileSync(outputPath, "tampered", "utf8");
    await expect(authority.execute(writeCommand, new Date(NOW.getTime() + 120_000)))
      .rejects.toThrow("already exists with different content");

    await expect(authority.execute({
      id: "REQ-CREDENTIAL-DIRECT-RECORD-0001",
      operation: "credential-passport-record",
      payload: { value: {}, expectedVersion: 0 }
    }, NOW)).rejects.toThrow("must use credential-import-artifact");
  });
});
