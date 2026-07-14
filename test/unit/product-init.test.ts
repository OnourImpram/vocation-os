import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthorityOperation, VocationRequestOptions } from "@vocation-os/sdk";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { runProductInitialization, type ProductInitClient } from "../../src/product-init.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import { ArtifactVault } from "../../src/storage/artifact-vault.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";

const START = new Date("2026-07-12T02:00:00.000Z");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("single command product initialization", () => {
  let root: string;
  let store: EncryptedEventStore;
  let vault: ArtifactVault;
  let authority: RuntimeAuthority;
  let tick: number;
  let client: ProductInitClient;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-product-init-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), "product init integration passphrase");
    vault = new ArtifactVault({ rootPath: path.join(root, "artifacts"), masterKey: Buffer.alloc(32, 0x71) });
    authority = new RuntimeAuthority(store, new MemoryCredentialStore(), root, vault);
    tick = 0;
    client = {
      request: async (operation: AuthorityOperation, payload: unknown = {}, options: VocationRequestOptions = {}) => {
        tick += 1;
        return authority.execute({
          id: options.requestId ?? `REQ-PRODUCT-INIT-${tick.toString().padStart(4, "0")}`,
          operation,
          payload
        }, new Date(START.getTime() + tick * 1_000));
      }
    };
  });

  afterEach(async () => {
    vault.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("completes demo onboarding with a persisted profile and first opportunity", async () => {
    const result = await runProductInitialization(client, { mode: "demo" });

    expect(result).toMatchObject({
      mode: "demo",
      nextAction: "complete",
      session: { status: "complete", currentStep: "complete", version: 8 }
    });
    expect(result.profileRecordId).toMatch(/^DEMO-TWIN-/);
    expect(result.opportunityRecordId).toMatch(/^OPP-MANUAL-/);
    await expect(authority.execute({
      id: "REQ-PRODUCT-INIT-LIST-PROFILES",
      operation: "domain-list",
      payload: { domain: "profiles" }
    })).resolves.toEqual([expect.objectContaining({ recordId: result.profileRecordId })]);
    await expect(authority.execute({
      id: "REQ-PRODUCT-INIT-LIST-OPPORTUNITIES",
      operation: "domain-list",
      payload: { domain: "opportunities" }
    })).resolves.toEqual([expect.objectContaining({ recordId: result.opportunityRecordId })]);
    expect((await store.verifyIntegrity()).eventCount).toBe(11);
  });

  it("imports a real local profile artifact and stops before unverified claim review", async () => {
    const profilePath = path.join(root, "operator-profile.txt");
    writeFileSync(profilePath, Buffer.from("private profile source bytes", "utf8"));

    const result = await runProductInitialization(client, { mode: "profile", profilePath });

    expect(result).toMatchObject({
      mode: "profile",
      nextAction: "claim-review",
      profileRecordId: null,
      opportunityRecordId: null,
      session: { status: "active", currentStep: "claim-review", version: 3 }
    });
    expect(result.artifactManifest).toMatchObject({ format: "vocation-os-artifact", cipher: "aes-256-gcm" });
    expect(result.profileImportPlan).toMatchObject({ approvalRequired: true, candidateCount: 1 });
    expect(JSON.stringify(await store.readAll())).not.toContain(profilePath);
    await expect(authority.execute({
      id: "REQ-PRODUCT-INIT-LIST-PROFILES",
      operation: "domain-list",
      payload: { domain: "profiles" }
    })).resolves.toEqual([]);
    expect((await store.verifyIntegrity()).eventCount).toBe(6);
  });

  it("reads the current onboarding aggregate instead of replaying the original start receipt", async () => {
    const profilePath = path.join(root, "operator-profile.txt");
    writeFileSync(profilePath, Buffer.from("private profile source bytes", "utf8"));
    const initialized = await runProductInitialization(client, { mode: "profile", profilePath });

    const resumed = await runProductInitialization(client, { mode: "resume" });

    expect(initialized.session).toMatchObject({ currentStep: "claim-review", version: 3 });
    expect(resumed).toMatchObject({
      mode: "resume",
      nextAction: "continue-onboarding",
      session: { currentStep: "claim-review", version: 3, status: "active" }
    });
    expect((await store.verifyIntegrity()).eventCount).toBe(6);
  });

  it("rejects resume when no onboarding session exists", async () => {
    await expect(runProductInitialization(client, { mode: "resume" }))
      .rejects.toThrow("No onboarding session exists to resume");
    expect((await store.chainHead()).eventCount).toBe(0);
  });

  it("reloads canonical state when another initializer wins the resume mutation race", async () => {
    const started = await authority.execute({
      id: "REQ-PRODUCT-INIT-RACE-START",
      operation: "onboarding-start",
      payload: { initializationMode: "demo" }
    }, START) as { version: number };
    await authority.execute({
      id: "REQ-PRODUCT-INIT-RACE-FAIL",
      operation: "onboarding-fail",
      payload: {
        expectedVersion: started.version,
        step: "runtime",
        reasonCode: "synthetic-interruption",
        resultPointer: "redacted:00000000-0000-4000-8000-000000000901"
      }
    }, new Date(START.getTime() + 1_000));
    const resumeObserved = deferred();
    const releaseResume = deferred();
    const delayedClient: ProductInitClient = {
      request: async (operation, payload = {}, options = {}) => {
        if (operation === "onboarding-resume") {
          resumeObserved.resolve();
          await releaseResume.promise;
        }
        return client.request(operation, payload, options);
      }
    };
    const delayedResume = runProductInitialization(delayedClient, { mode: "resume" });
    await resumeObserved.promise;

    const concurrent = await runProductInitialization(client, { mode: "demo" });
    releaseResume.resolve();
    const resumed = await delayedResume;

    expect(concurrent.session).toMatchObject({ status: "complete", version: 10 });
    expect(resumed).toMatchObject({
      nextAction: "complete",
      session: { sessionId: concurrent.session.sessionId, status: "complete", version: 10 }
    });
  });

  it("retries a step against the canonical version after a same-step fail and resume race", async () => {
    const stepObserved = deferred();
    const releaseStep = deferred();
    let delayed = false;
    const delayedClient: ProductInitClient = {
      request: async (operation, payload = {}, options = {}) => {
        if (
          !delayed
          && operation === "onboarding-complete-step"
          && (payload as { step?: unknown }).step === "runtime"
        ) {
          delayed = true;
          stepObserved.resolve();
          await releaseStep.promise;
        }
        return client.request(operation, payload, options);
      }
    };
    const initialization = runProductInitialization(delayedClient, { mode: "demo" });
    await stepObserved.promise;
    const active = await authority.execute({
      id: "REQ-PRODUCT-INIT-SAME-STEP-STATUS",
      operation: "onboarding-status",
      payload: {}
    }) as { version: number };
    const failed = await authority.execute({
      id: "REQ-PRODUCT-INIT-SAME-STEP-FAIL",
      operation: "onboarding-fail",
      payload: {
        expectedVersion: active.version,
        step: "runtime",
        reasonCode: "synthetic-same-step-race",
        resultPointer: "redacted:00000000-0000-4000-8000-000000000902"
      }
    }, new Date(START.getTime() + 100_000)) as { version: number };
    await authority.execute({
      id: "REQ-PRODUCT-INIT-SAME-STEP-RESUME",
      operation: "onboarding-resume",
      payload: { expectedVersion: failed.version, step: "runtime" }
    }, new Date(START.getTime() + 101_000));

    tick = 200;
    releaseStep.resolve();
    const result = await initialization;

    expect(result).toMatchObject({
      nextAction: "complete",
      session: { status: "complete", currentStep: "complete", version: 10 }
    });
  });

  it("rejects a demo mode takeover while profile onboarding is awaiting claim review", async () => {
    const profilePath = path.join(root, "operator-profile.txt");
    writeFileSync(profilePath, Buffer.from("private profile source bytes", "utf8"));
    const stepObserved = deferred();
    const releaseStep = deferred();
    let delayed = false;
    const delayedClient: ProductInitClient = {
      request: async (operation, payload = {}, options = {}) => {
        if (
          !delayed
          && operation === "onboarding-complete-step"
          && (payload as { step?: unknown }).step === "profile-import"
        ) {
          delayed = true;
          stepObserved.resolve();
          await releaseStep.promise;
        }
        return client.request(operation, payload, options);
      }
    };
    const profileInitialization = runProductInitialization(delayedClient, { mode: "profile", profilePath });
    await stepObserved.promise;

    await expect(runProductInitialization(client, { mode: "demo" }))
      .rejects.toThrow("Onboarding mode is locked to profile");
    releaseStep.resolve();
    const profileResult = await profileInitialization;

    expect(profileResult).toMatchObject({
      nextAction: "claim-review",
      session: { initializationMode: "profile", status: "active", currentStep: "claim-review", version: 3 }
    });
    await expect(authority.execute({
      id: "REQ-PRODUCT-INIT-MODE-LOCK-PROFILES",
      operation: "domain-list",
      payload: { domain: "profiles" }
    })).resolves.toEqual([]);
  });

  it("recovers the active profile plan after the client loses the first response", async () => {
    const profilePath = path.join(root, "operator-profile.txt");
    writeFileSync(profilePath, Buffer.from("private profile source bytes", "utf8"));
    const first = await runProductInitialization(client, { mode: "profile", profilePath });

    const recovered = await runProductInitialization(client, { mode: "profile", profilePath });

    expect(first.profileImportPlan).toMatchObject({ planHash: first.session.profilePlanHash });
    expect(recovered.profileImportPlan).toEqual(first.profileImportPlan);
    expect(recovered.artifactManifest).toEqual(first.artifactManifest);
    expect(recovered).toMatchObject({
      nextAction: "claim-review",
      session: { profilePlanHash: first.session.profilePlanHash, currentStep: "claim-review" }
    });
  });
});
