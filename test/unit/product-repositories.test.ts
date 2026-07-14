import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCareerTwin } from "../../src/career-twin.js";
import type { DocumentAst } from "../../src/document-ast.js";
import { createApplicationAttempt } from "../../src/application-lifecycle.js";
import { createOpportunityRecord } from "../../src/opportunity.js";
import { createOutcomeEvent } from "../../src/outcome-learning.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import {
  PRODUCT_DOMAIN_NAMES,
  ProductRepositories,
  type CampaignRecord,
  type CareerTaskRecord
} from "../../src/storage/product-repositories.js";
import { demoGraph, noHighStakesFlags } from "../fixtures.js";
import { computeClaimTextHash } from "../../src/hash.js";
import type { AnswerMemoryRecord } from "../../src/answer-memory.js";

const PASSPHRASE = "product repository integration passphrase";
const NOW = new Date("2026-07-12T00:00:00.000Z");

function requestId(seed: number): string {
  return `REQ-PRODUCT-REPOSITORY-${seed.toString().padStart(4, "0")}`;
}

describe("encrypted product domain repositories", () => {
  let root: string;
  let store: EncryptedEventStore;
  let repositories: ProductRepositories;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-product-repositories-"));
    store = await EncryptedEventStore.open(path.join(root, "vocation.db"), PASSPHRASE);
    repositories = new ProductRepositories(store);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists every product domain through versioned encrypted aggregates", async () => {
    const profile = createCareerTwin("synthetic", [], [], NOW);
    const opportunity = createOpportunityRecord({
      source: "manual",
      sourceId: "PRODUCT-001",
      sourceUrl: "https://example.test/jobs/product-001",
      applyUrl: "https://example.test/jobs/product-001/apply",
      company: "Synthetic Product Lab",
      roleTitle: "Career Systems Researcher",
      locationText: "Remote worldwide",
      remotePolicy: "remote",
      applicantLocationRequirements: ["worldwide"],
      descriptionText: "Synthetic product repository fixture with sufficient detail for deterministic validation.",
      postedAt: NOW.toISOString(),
      capturedAt: NOW.toISOString(),
      extractionConfidence: "high",
      sourcePayload: { fixture: true }
    });
    const document: DocumentAst = {
      documentId: "DOC-PRODUCT-001",
      kind: "cv",
      profileId: demoGraph().profileId,
      opportunityId: opportunity.opportunityId,
      generatedAt: NOW.toISOString(),
      sections: [{
        sectionId: "SEC-PRODUCT-001",
        label: "Profile",
        nodes: [{ nodeId: "NODE-PRODUCT-001", type: "heading", level: 1, text: "Profile", claimIds: [] }]
      }]
    };
    const campaign: CampaignRecord = {
      campaignId: "CAM-PRODUCT-001",
      profileId: demoGraph().profileId,
      name: "Synthetic product campaign",
      objective: "Validate the complete domain repository surface.",
      status: "active",
      opportunityIds: [opportunity.opportunityId],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    };
    const application = createApplicationAttempt({
      opportunityId: opportunity.opportunityId,
      packetHash: `sha256:${"a".repeat(64)}`,
      adapterId: "local-fixture",
      channel: "ats-form",
      reversibilityTag: "R3",
      highStakesFlags: noHighStakesFlags(),
      now: NOW
    });
    const task: CareerTaskRecord = {
      taskId: "TSK-PRODUCT-001",
      title: "Review synthetic opportunity",
      status: "pending",
      priority: 80,
      relatedDomain: "opportunities",
      relatedRecordId: opportunity.opportunityId,
      dueAt: null,
      completedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    };
    const outcome = createOutcomeEvent({
      opportunityId: opportunity.opportunityId,
      stage: "discovered",
      occurredAt: NOW.toISOString(),
      source: "operator",
      modelVersion: "none",
      policyVersion: "v0.5",
      documentVariantId: null,
      messageVariantId: null,
      evidencePointer: "fixture:product-repository"
    });
    const answerPrompt = "Are you available to work remotely?";
    const answerText = "Yes, for roles with an explicit remote policy.";
    const answer: AnswerMemoryRecord = {
      answerId: "ANS-PRODUCT-001",
      questionType: "custom",
      normalizedPrompt: answerPrompt,
      promptHash: computeClaimTextHash(answerPrompt),
      answerText,
      answerHash: computeClaimTextHash(answerText),
      evidenceStatus: "operator_supplied",
      sourcePointer: "fixture:product-repository",
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

    const records = await Promise.all([
      repositories.profiles.put({ value: profile, expectedVersion: 0, operationId: requestId(1), now: NOW }),
      repositories.opportunities.put({ value: opportunity, expectedVersion: 0, operationId: requestId(2), now: NOW }),
      repositories.documents.put({ value: document, expectedVersion: 0, operationId: requestId(3), now: NOW }),
      repositories.campaigns.put({ value: campaign, expectedVersion: 0, operationId: requestId(4), now: NOW }),
      repositories.applications.put({ value: application, expectedVersion: 0, operationId: requestId(5), now: NOW }),
      repositories.tasks.put({ value: task, expectedVersion: 0, operationId: requestId(6), now: NOW }),
      repositories.outcomes.put({ value: outcome, expectedVersion: 0, operationId: requestId(7), now: NOW }),
      repositories.answers.put({ value: answer, expectedVersion: 0, operationId: requestId(8), now: NOW })
    ]);

    expect(records.map((record) => record.domain)).toEqual(PRODUCT_DOMAIN_NAMES);
    expect(records.every((record) => record.version === 1 && record.status === "active")).toBe(true);
    expect((await store.verifyIntegrity()).eventCount).toBe(8);
  });

  it("enforces idempotency optimistic concurrency and archive visibility", async () => {
    const task: CareerTaskRecord = {
      taskId: "TSK-PRODUCT-REPLAY",
      title: "Review repository replay",
      status: "pending",
      priority: 50,
      relatedDomain: null,
      relatedRecordId: null,
      dueAt: null,
      completedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    };
    const command = { value: task, expectedVersion: 0, operationId: requestId(20), now: NOW };
    const created = await repositories.tasks.put(command);
    await expect(repositories.tasks.put(command)).resolves.toEqual(created);
    await expect(repositories.tasks.put({
      ...command,
      value: { ...task, title: "Changed replay content" }
    })).rejects.toThrow("different content");
    await expect(repositories.tasks.put({
      value: { ...task, status: "in-progress", updatedAt: new Date(NOW.getTime() + 1_000).toISOString() },
      expectedVersion: 0,
      operationId: requestId(21),
      now: new Date(NOW.getTime() + 1_000)
    })).rejects.toThrow("version conflict");

    const archived = await repositories.tasks.archive({
      recordId: task.taskId,
      expectedVersion: 1,
      operationId: requestId(22),
      now: new Date(NOW.getTime() + 2_000)
    });
    expect(archived).toMatchObject({ version: 2, status: "archived" });
    await expect(repositories.tasks.get(task.taskId)).resolves.toBeNull();
    await expect(repositories.tasks.get(task.taskId, true)).resolves.toEqual(archived);
    await expect(repositories.tasks.list()).resolves.toEqual([]);
    await expect(repositories.tasks.list(true)).resolves.toEqual([archived]);
    expect((await store.verifyIntegrity()).eventCount).toBe(2);
  });
});
