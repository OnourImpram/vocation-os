import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthorityOperation, VocationRequestOptions } from "@vocation-os/sdk";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { computeClaimTextHash } from "../../src/hash.js";
import type { ClaimGraph } from "../../src/types.js";
import type { DocumentAstV2 } from "../../src/documents/document-ast-v2.js";
import { writeDocumentBundle } from "../../src/documents/document-renderer.js";
import { runProductInitialization, type ProductInitClient } from "../../src/product-init.js";
import { createOutcomeEvent } from "../../src/outcome-learning.js";
import type { AnswerMemoryRecord } from "../../src/answer-memory.js";
import type { CareerTaskRecord } from "../../src/storage/product-repositories.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import { ArtifactVault } from "../../src/storage/artifact-vault.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { noHighStakesFlags } from "../fixtures.js";

const NOW = new Date("2026-07-12T07:00:00.000Z");
const CLAIM_TEXT = "Synthetic operator completed an evidence grounded career systems project.";

describe("golden local first product journey", () => {
  let root: string;
  let store: EncryptedEventStore;
  let vault: ArtifactVault;
  let authority: RuntimeAuthority;
  let client: ProductInitClient;
  let tick: number;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-golden-journey-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), "golden journey passphrase");
    vault = new ArtifactVault({ rootPath: path.join(root, "artifacts"), masterKey: Buffer.alloc(32, 0x31) });
    authority = new RuntimeAuthority(store, new MemoryCredentialStore(), root, vault);
    tick = 0;
    client = {
      request: async (operation: AuthorityOperation, payload: unknown = {}, options: VocationRequestOptions = {}) => {
        tick += 1;
        return authority.execute({
          id: options.requestId ?? `REQ-GOLDEN-${tick.toString().padStart(8, "0")}`,
          operation,
          payload
        }, new Date(NOW.getTime() + tick * 1_000));
      }
    };
  });

  afterEach(async () => {
    vault.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("onboards discovers renders tracks and records outcomes in one runtime", async () => {
    const initialized = await runProductInitialization(client, { mode: "demo" });
    const profileId = initialized.profileRecordId;
    const opportunityId = initialized.opportunityRecordId;
    if (!profileId || !opportunityId) throw new Error("Demo initialization did not create product records");
    const graph: ClaimGraph = {
      profileId,
      profileScope: "synthetic",
      generatedAt: NOW.toISOString(),
      graphVersion: "0.5.0",
      claims: [{
        claimId: "CLM-GOLDEN-001",
        text: CLAIM_TEXT,
        canonicalTextHash: computeClaimTextHash(CLAIM_TEXT),
        claimType: "project",
        evidenceStatus: "verified",
        sourceType: "operator-supplied",
        sourcePointer: "fixture:golden-journey",
        verifiedDate: "2026-07-12",
        recencyRequired: false,
        publiclyAssertable: true,
        allowedInCv: true,
        allowedInOutreach: true,
        allowedInAutoApply: false
      }],
      validationSummary: { verifiedClaims: 1, unverifiedClaims: 0, privateClaims: 0 }
    };
    const document: DocumentAstV2 = {
      schemaVersion: 2,
      documentId: "DOC-GOLDEN-001",
      kind: "cv",
      profileId,
      opportunityId,
      titleKey: "cv",
      locale: "en",
      generatedAt: NOW.toISOString(),
      layout: { pageSize: "A4", marginPoints: 48, bodyFontSize: 10.5 },
      sections: [{
        sectionId: "SEC-GOLDEN-001",
        labelKey: "selected-evidence",
        nodes: [{
          nodeId: "NODE-GOLDEN-001",
          type: "bullet",
          bindingMode: "verbatim-claim",
          text: CLAIM_TEXT,
          claimIds: ["CLM-GOLDEN-001"],
          textHash: computeClaimTextHash(CLAIM_TEXT)
        }]
      }]
    };
    const output = await writeDocumentBundle(document, graph, path.join(root, "exports"), NOW);
    await authority.execute({
      id: "REQ-GOLDEN-DOCUMENT-PUT",
      operation: "domain-put",
      payload: { domain: "documents", expectedVersion: 0, value: document, claimGraph: graph }
    }, new Date(NOW.getTime() + 30_000));
    const tracker = await authority.execute({
      id: "REQ-GOLDEN-TRACKER-CREATE",
      operation: "tracker-create",
      payload: {
        input: {
          opportunityId,
          packetHash: `sha256:${"a".repeat(64)}`,
          adapterId: "local-fixture",
          channel: "ats-form",
          reversibilityTag: "R3",
          highStakesFlags: noHighStakesFlags()
        }
      }
    }, new Date(NOW.getTime() + 31_000)) as { value: { status: string } };
    const task: CareerTaskRecord = {
      taskId: "TSK-GOLDEN-001",
      title: "Review the synthetic application packet",
      status: "pending",
      priority: 90,
      relatedDomain: "opportunities",
      relatedRecordId: opportunityId,
      dueAt: null,
      completedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    };
    await authority.execute({
      id: "REQ-GOLDEN-TASK-PUT",
      operation: "domain-put",
      payload: { domain: "tasks", expectedVersion: 0, value: task }
    }, new Date(NOW.getTime() + 32_000));
    const outcome = createOutcomeEvent({
      opportunityId,
      stage: "discovered",
      occurredAt: NOW.toISOString(),
      source: "operator",
      modelVersion: "none",
      policyVersion: "v0.5",
      documentVariantId: document.documentId,
      messageVariantId: null,
      evidencePointer: "fixture:golden-journey"
    });
    await authority.execute({
      id: "REQ-GOLDEN-OUTCOME-PUT",
      operation: "domain-put",
      payload: { domain: "outcomes", expectedVersion: 0, value: outcome }
    }, new Date(NOW.getTime() + 33_000));
    const answerText = "Fully remote roles with explicit applicant geography";
    const answerPrompt = "What work arrangement do you prefer?";
    const answer: AnswerMemoryRecord = {
      answerId: "ANS-GOLDEN-001",
      questionType: "custom",
      normalizedPrompt: answerPrompt,
      promptHash: computeClaimTextHash(answerPrompt),
      answerText,
      answerHash: computeClaimTextHash(answerText),
      evidenceStatus: "operator_supplied",
      sourcePointer: "operator:golden-journey",
      scope: "global",
      roleFamily: null,
      opportunityId: null,
      sensitivity: "standard",
      reusable: true,
      requiresPerOpportunityConfirmation: false,
      allowedModes: ["assist", "supervised"],
      expiresAt: null,
      status: "active",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    };
    await authority.execute({
      id: "REQ-GOLDEN-ANSWER-PUT",
      operation: "domain-put",
      payload: { domain: "answers", expectedVersion: 0, value: answer }
    }, new Date(NOW.getTime() + 34_000));

    expect(initialized.session.status).toBe("complete");
    expect(output.verification.valid).toBe(true);
    expect(tracker.value.status).toBe("prepared");
    await expect(authority.execute({ id: "REQ-GOLDEN-DOCUMENT-LIST", operation: "domain-list", payload: { domain: "documents" } }))
      .resolves.toHaveLength(1);
    await expect(authority.execute({ id: "REQ-GOLDEN-TRACKER-LIST", operation: "tracker-list", payload: {} }))
      .resolves.toHaveLength(1);
    await expect(authority.execute({ id: "REQ-GOLDEN-TASK-LIST", operation: "domain-list", payload: { domain: "tasks" } }))
      .resolves.toHaveLength(1);
    await expect(authority.execute({ id: "REQ-GOLDEN-OUTCOME-LIST", operation: "domain-list", payload: { domain: "outcomes" } }))
      .resolves.toHaveLength(1);
    await expect(authority.execute({ id: "REQ-GOLDEN-ANSWER-LIST", operation: "domain-list", payload: { domain: "answers" } }))
      .resolves.toHaveLength(1);
    expect((await store.verifyIntegrity()).eventCount).toBe(16);
  }, 15_000);
});
