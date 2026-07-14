import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import {
  ONBOARDING_ACTIONABLE_STEPS,
  type OnboardingSession,
  type RedactedResultPointer,
  type Sha256Digest
} from "../../src/onboarding.js";
import { ArtifactVault } from "../../src/storage/artifact-vault.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import type { CareerTaskRecord, VersionedDomainRecord } from "../../src/storage/product-repositories.js";
import { ProductRepositories } from "../../src/storage/product-repositories.js";
import { careerTwinFromImportPlan, type ProfileImportPlan } from "../../src/import/profile-import.js";
import { createCareerTwin } from "../../src/career-twin.js";
import { createOpportunityRecord } from "../../src/opportunity.js";

const PASSPHRASE = "product authority integration passphrase";
const MASTER_KEY = Buffer.alloc(32, 0x61);
const START = new Date("2026-07-12T01:00:00.000Z");

function now(offset: number): Date {
  return new Date(START.getTime() + offset * 1_000);
}

function digest(seed: number): Sha256Digest {
  return `sha256:${seed.toString(16).padStart(64, "0")}`;
}

function pointer(seed: number): RedactedResultPointer {
  return `redacted:00000000-0000-4000-8000-${seed.toString().padStart(12, "0")}`;
}

describe("product operations behind vocationd authority", () => {
  let root: string;
  let store: EncryptedEventStore;
  let vault: ArtifactVault;
  let authority: RuntimeAuthority;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-product-authority-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), PASSPHRASE);
    vault = new ArtifactVault({ rootPath: path.join(root, "artifacts"), masterKey: MASTER_KEY });
    authority = new RuntimeAuthority(store, new MemoryCredentialStore(), root, vault);
  });

  afterEach(async () => {
    vault.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("imports artifacts without persisting the source path and replays idempotently", async () => {
    const sourcePath = path.join(root, "private-person-name-resume.pdf");
    const content = Buffer.from("private resume bytes for an authority test", "utf8");
    writeFileSync(sourcePath, content);
    const request = {
      id: "REQ-ARTIFACT-IMPORT-0001",
      operation: "artifact-import" as const,
      payload: { sourcePath }
    };

    const manifest = await authority.execute(request, now(1));
    const replay = await authority.execute(request, now(2));

    expect(replay).toEqual(manifest);
    expect(await authority.execute({
      id: "REQ-ARTIFACT-LIST-0001",
      operation: "artifact-list",
      payload: {}
    })).toEqual([manifest]);
    expect(vault.read(manifest)).toEqual(content);
    const persisted = JSON.stringify(await store.readAll());
    expect(persisted).not.toContain(sourcePath);
    expect(persisted).not.toContain(path.basename(sourcePath));
    expect((await store.chainHead()).eventCount).toBe(1);

    const otherPath = path.join(root, "other.pdf");
    writeFileSync(otherPath, "other", "utf8");
    await expect(authority.execute({ ...request, payload: { sourcePath: otherPath } }, now(3)))
      .rejects.toThrow("request id was reused with different parameters");
  });

  it("persists and resumes the complete onboarding aggregate across authority reconstruction", async () => {
    let session = await authority.execute({
      id: "REQ-ONBOARDING-START-0001",
      operation: "onboarding-start",
      payload: { initializationMode: "demo" }
    }, START) as OnboardingSession;

    for (const [index, step] of ONBOARDING_ACTIONABLE_STEPS.entries()) {
      if (step === "profile-import") {
        const profile = createCareerTwin("synthetic", [], [], now(index + 1));
        await authority.execute({
          id: "REQ-ONBOARDING-DEMO-PROFILE-0001",
          operation: "domain-put",
          payload: { domain: "profiles", expectedVersion: 0, value: profile }
        }, now(index + 1));
      }
      if (step === "first-discovery") {
        const opportunity = createOpportunityRecord({
          source: "manual",
          sourceId: "ONBOARDING-AUTHORITY-TEST",
          sourceUrl: "https://example.test/vocation-os/onboarding-authority",
          applyUrl: null,
          company: "Synthetic Career Systems Lab",
          roleTitle: "Career Systems Researcher",
          locationText: "Remote worldwide",
          remotePolicy: "remote",
          applicantLocationRequirements: ["worldwide"],
          descriptionText: "Synthetic first discovery prerequisite.",
          postedAt: null,
          capturedAt: now(index + 1).toISOString(),
          extractionConfidence: "high",
          sourcePayload: { fixture: true }
        });
        await authority.execute({
          id: "REQ-ONBOARDING-DEMO-OPPORTUNITY-0001",
          operation: "domain-put",
          payload: { domain: "opportunities", expectedVersion: 0, value: opportunity }
        }, now(index + 1));
      }
      session = await authority.execute({
        id: `REQ-ONBOARDING-STEP-${(index + 1).toString().padStart(4, "0")}`,
        operation: "onboarding-complete-step",
        payload: {
          expectedVersion: session.version,
          step,
          result: {
            outcome: "completed",
            resultPointer: pointer(index + 1),
            contentHash: digest(index + 1)
          }
        }
      }, now(index + 1)) as OnboardingSession;
    }

    expect(session).toMatchObject({ status: "complete", currentStep: "complete", version: 8 });
    const reconstructed = new RuntimeAuthority(store, new MemoryCredentialStore(), root, vault);
    await expect(reconstructed.execute({
      id: "REQ-ONBOARDING-STATUS-0001",
      operation: "onboarding-status",
      payload: {}
    })).resolves.toEqual(session);
    expect((await store.chainHead()).eventCount).toBe(11);
  });

  it("cannot advance demo onboarding past profile import without a persisted synthetic profile", async () => {
    let session = await authority.execute({
      id: "REQ-ONBOARDING-PREREQUISITE-START",
      operation: "onboarding-start",
      payload: { initializationMode: "demo" }
    }, START) as OnboardingSession;
    for (const [index, step] of (["runtime", "privacy"] as const).entries()) {
      session = await authority.execute({
        id: `REQ-ONBOARDING-PREREQUISITE-${step.toUpperCase()}`,
        operation: "onboarding-complete-step",
        payload: {
          expectedVersion: session.version,
          step,
          result: { outcome: "completed", resultPointer: pointer(index + 20), contentHash: digest(index + 20) }
        }
      }, now(index + 1)) as OnboardingSession;
    }
    await expect(authority.execute({
      id: "REQ-ONBOARDING-PREREQUISITE-PROFILE",
      operation: "onboarding-complete-step",
      payload: {
        expectedVersion: session.version,
        step: "profile-import",
        result: { outcome: "completed", resultPointer: pointer(22), contentHash: digest(22) }
      }
    }, now(3))).rejects.toThrow("requires a persisted synthetic profile");
  });

  it("enforces daemon owned domain versions archive behavior and request replay", async () => {
    const task: CareerTaskRecord = {
      taskId: "TSK-AUTHORITY-001",
      title: "Review product authority",
      status: "pending",
      priority: 75,
      relatedDomain: null,
      relatedRecordId: null,
      dueAt: null,
      completedAt: null,
      createdAt: START.toISOString(),
      updatedAt: START.toISOString()
    };
    const request = {
      id: "REQ-DOMAIN-PUT-0001",
      operation: "domain-put" as const,
      payload: { domain: "tasks", expectedVersion: 0, value: task }
    };
    const created = await authority.execute(request, now(1)) as VersionedDomainRecord<CareerTaskRecord>;
    await expect(authority.execute(request, now(2))).resolves.toEqual(created);
    await expect(authority.execute({
      id: "REQ-DOMAIN-PUT-0002",
      operation: "domain-put",
      payload: { domain: "tasks", expectedVersion: 0, value: { ...task, title: "Stale update" } }
    }, now(2))).rejects.toThrow("version conflict");

    const archived = await authority.execute({
      id: "REQ-DOMAIN-ARCHIVE-0001",
      operation: "domain-archive",
      payload: { domain: "tasks", recordId: task.taskId, expectedVersion: 1 }
    }, now(3));
    expect(archived).toMatchObject({ version: 2, status: "archived" });
    await expect(authority.execute({
      id: "REQ-DOMAIN-GET-0001",
      operation: "domain-get",
      payload: { domain: "tasks", recordId: task.taskId }
    })).resolves.toBeNull();
    await expect(authority.execute({
      id: "REQ-DOMAIN-LIST-0001",
      operation: "domain-list",
      payload: { domain: "tasks", includeArchived: true }
    })).resolves.toEqual([archived]);

    const repeatedArchive = {
      id: "REQ-DOMAIN-ARCHIVE-NOOP-0001",
      operation: "domain-archive" as const,
      payload: { domain: "tasks", recordId: task.taskId, expectedVersion: 2 }
    };
    await expect(authority.execute(repeatedArchive, now(4))).resolves.toEqual(archived);
    await expect(authority.execute(repeatedArchive, now(5))).resolves.toEqual(archived);
  });

  it("rejects generic application archival before resolving a record", async () => {
    await expect(authority.execute({
      id: "REQ-APPLICATION-ARCHIVE-BYPASS-0001",
      operation: "domain-archive",
      payload: { domain: "applications", recordId: "ATT-2026-00000000-0000-4000-8000-000000000001", expectedVersion: 1 }
    }, now(1))).rejects.toThrow("tracker lifecycle operations");
    expect((await store.chainHead()).eventCount).toBe(0);
  });

  it("blocks document persistence without a claim graph before writing an event", async () => {
    const eventCount = (await store.chainHead()).eventCount;
    await expect(authority.execute({
      id: "REQ-DOCUMENT-PUT-0001",
      operation: "domain-put",
      payload: {
        domain: "documents",
        expectedVersion: 0,
        value: {
          documentId: "DOC-AUTHORITY-001",
          kind: "cv",
          profileId: "DEMO-PROFILE-001",
          opportunityId: null,
          generatedAt: START.toISOString(),
          sections: []
        }
      }
    }, now(1))).rejects.toThrow("require a claim graph");
    expect((await store.chainHead()).eventCount).toBe(eventCount);
    expect(existsSync(path.join(root, "domain-documents"))).toBe(false);
  });

  it("binds profile import application to the persisted plan hash", async () => {
    const source = Buffer.from("Licensed clinical psychologist\nResponsible AI researcher\n", "utf8");
    const manifest = vault.store(source).manifest;
    const planRequest = {
      id: "REQ-PROFILE-IMPORT-PLAN-0001",
      operation: "profile-import-plan" as const,
      payload: { manifest, format: "text" }
    };
    const plan = await authority.execute(planRequest, now(1)) as ProfileImportPlan;
    await expect(authority.execute(planRequest, now(2))).resolves.toEqual(plan);
    expect(plan.candidateCount).toBe(2);

    await expect(authority.execute({
      id: "REQ-PROFILE-IMPORT-APPLY-BAD",
      operation: "profile-import-apply",
      payload: { planHash: `sha256:${"f".repeat(64)}` }
    }, now(3))).rejects.toThrow("plan was not found");

    const profile = await authority.execute({
      id: "REQ-PROFILE-IMPORT-APPLY-0001",
      operation: "profile-import-apply",
      payload: { planHash: plan.planHash }
    }, now(4)) as VersionedDomainRecord<{ facts: Array<{ evidenceStatus: string; allowedUses: string[] }> }>;
    expect(profile.recordId).toMatch(/^LOCAL-TWIN-/);
    expect(profile.value.facts).toHaveLength(2);
    expect(profile.value.facts.every((fact) =>
      fact.evidenceStatus === "operator_supplied"
      && fact.allowedUses.length === 1
      && fact.allowedUses[0] === "analysis"
    )).toBe(true);
    await expect(authority.execute({
      id: "REQ-PROFILE-IMPORT-APPLY-0002",
      operation: "profile-import-apply",
      payload: { planHash: plan.planHash }
    }, now(5))).resolves.toEqual(profile);
    await expect(authority.execute({
      id: "REQ-PROFILE-IMPORT-APPLY-0002",
      operation: "auto-apply-kill",
      payload: { reason: "must not reuse a bound request id" }
    }, now(6))).rejects.toThrow("request id was reused with different parameters");
  });

  it("rejects a preseeded imported profile that is not exactly bound to the approved plan", async () => {
    const manifest = vault.store(Buffer.from("Verified source fact", "utf8")).manifest;
    const plan = await authority.execute({
      id: "REQ-PROFILE-PRESEED-PLAN-0001",
      operation: "profile-import-plan",
      payload: { manifest, format: "text" }
    }, now(1)) as ProfileImportPlan;
    const expected = careerTwinFromImportPlan(plan);
    await new ProductRepositories(store).profiles.put({
      value: {
        ...expected,
        facts: [{ ...expected.facts[0]!, label: "UNBOUND PRESEEDED FACT", value: "UNBOUND PRESEEDED FACT" }]
      },
      expectedVersion: 0,
      operationId: "REQ-PROFILE-PRESEED-DIRECT-0001",
      now: now(2)
    });

    await expect(authority.execute({
      id: "REQ-PROFILE-PRESEED-APPLY-0001",
      operation: "profile-import-apply",
      payload: { planHash: plan.planHash }
    }, now(3))).rejects.toThrow("not bound to the approved plan");
  });

  it("rejects a receipt redirected to another authenticated event", async () => {
    const first = {
      id: "REQ-RECEIPT-BINDING-0001",
      operation: "onboarding-start" as const,
      payload: { initializationMode: "demo" }
    };
    await authority.execute(first, now(1));
    await authority.execute({
      id: "REQ-RECEIPT-BINDING-0002",
      operation: "onboarding-start",
      payload: { initializationMode: "demo" }
    }, now(2));
    const secondReceipt = store.findAuthorityReceipt("REQ-RECEIPT-BINDING-0002");
    if (!secondReceipt?.eventId) throw new Error("Receipt fixture was not persisted");
    const sqlite = new Database(store.path());
    try {
      sqlite.prepare(`
        UPDATE authority_receipts
        SET event_id = ?, response_hash = ?
        WHERE request_id = ?
      `).run(secondReceipt.eventId, secondReceipt.responseHash, first.id);
    } finally {
      sqlite.close();
    }

    await expect(authority.execute(first, now(3))).rejects.toThrow("deterministic replay event");
  });

  it("binds a no-op onboarding start request before returning the existing session", async () => {
    const created = await authority.execute({
      id: "REQ-ONBOARDING-START-BIND-0001",
      operation: "onboarding-start",
      payload: { initializationMode: "demo" }
    }, START);
    await expect(authority.execute({
      id: "REQ-ONBOARDING-START-BIND-0002",
      operation: "onboarding-start",
      payload: { initializationMode: "demo" }
    }, now(1))).resolves.toEqual(created);
    await expect(authority.execute({
      id: "REQ-ONBOARDING-START-BIND-0002",
      operation: "auto-apply-kill",
      payload: { reason: "must not reuse a bound request id" }
    }, now(2))).rejects.toThrow("request id was reused with different parameters");
  });
});
