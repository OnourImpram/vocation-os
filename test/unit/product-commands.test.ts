import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentIntegrationCommand,
  agentIntegrationStatus,
  assuranceCommand,
  discoveryCommand,
  discoveryStatus,
  modelProviderStatus,
  taxonomyCommand,
  type ProductCommandAuthority
} from "../../src/commands/product-commands.js";
import { sha256 } from "../../src/hash.js";
import { createTaxonomySnapshot } from "../../src/taxonomy/index.js";

describe("product command suite", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vocation-product-commands-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports discovery capability and persisted runtime counts without network access", async () => {
    const request = vi.fn(async (operation: string) => {
      if (operation === "source-observation-list") return [{ recordId: "OBS-1" }];
      if (operation === "opportunity-truth-list") return [];
      if (operation === "liveness-assessment-list") return [{ recordId: "LIVE-1" }];
      if (operation === "dedupe-result-list") return [];
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const result = await discoveryStatus({ request } as unknown as ProductCommandAuthority) as {
      providers: { contractTestedGaCount: number };
      catalog: { verifiedOrganizationCount: number };
      runtime: { observationCount: number; livenessAssessmentCount: number };
      networkExecution: string;
    };

    expect(result.providers.contractTestedGaCount).toBe(36);
    expect(result.catalog.verifiedOrganizationCount).toBeGreaterThanOrEqual(250);
    expect(result.runtime).toMatchObject({ observationCount: 1, livenessAssessmentCount: 1 });
    expect(result.networkExecution).toBe("requires-explicit-governed-network-grant");
  });

  it("registers signed grants and runs discovery only through explicit authority operations", async () => {
    const grantPath = path.join(root, "grant.json");
    const headersPath = path.join(root, "headers.json");
    const envelope = {
      grant: { grantId: "NAG-DEMO-0001", providerId: "greenhouse" },
      grantDigest: sha256("grant")
    };
    writeFileSync(grantPath, JSON.stringify(envelope), "utf8");
    writeFileSync(headersPath, JSON.stringify({ accept: "application/json" }), "utf8");
    const request = vi.fn(async (operation: string, payload: unknown, options: unknown) => ({
      operation,
      payload,
      options
    }));
    const authority = { request } as unknown as ProductCommandAuthority;

    await expect(discoveryCommand(authority, [
      "grant-register", "--file", grantPath, "--scope-url",
      "https://boards-api.greenhouse.io/v1/boards/demo/jobs",
      "--request-id", "REQ-NETWORK-GRANT-0001"
    ])).resolves.toMatchObject({ operation: "network-grant-register" });
    await expect(discoveryCommand(authority, [
      "run",
      "--provider", "greenhouse",
      "--grant", "NAG-DEMO-0001",
      "--source-key", "greenhouse:demo",
      "--url", "https://boards-api.greenhouse.io/v1/boards/demo/jobs",
      "--company", "Demo",
      "--headers", headersPath,
      "--request-id", "REQ-DISCOVERY-RUN-0001"
    ])).resolves.toMatchObject({
      operation: "discovery-run",
      payload: {
        providerId: "greenhouse",
        grantId: "NAG-DEMO-0001",
        headers: { accept: "application/json" },
        operatorScopedTarget: false
      },
      options: { requestId: "REQ-DISCOVERY-RUN-0001", timeoutMs: 60_000 }
    });
  });

  it("imports and deterministically maps a versioned taxonomy snapshot", async () => {
    const snapshot = createTaxonomySnapshot({
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
    const snapshotPath = path.join(root, "esco.json");
    writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
    const request = vi.fn(async (operation: string, payload: unknown) => {
      if (operation === "artifact-import") {
        return {
          format: "vocation-os-artifact",
          version: 1,
          cipher: "aes-256-gcm",
          contentHash: sha256(JSON.stringify(snapshot)),
          storageLocator: `hmac-sha256:${"1".repeat(64)}`,
          sizeBytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8")
        };
      }
      if (operation === "taxonomy-snapshot-import-artifact") {
        expect(payload).toMatchObject({ expectedVersion: 0 });
        return { record: { recordId: snapshot.snapshotId, version: 1 } };
      }
      if (operation === "taxonomy-query") {
        expect(payload).toEqual({
          snapshotId: snapshot.snapshotId,
          queries: ["AI engineer"],
          limit: 5,
          minimumScore: 0.25
        });
        return {
          matches: [{ query: "AI engineer", results: [{ conceptId: "esco:2512.1", score: 1 }] }]
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const authority = { request } as unknown as ProductCommandAuthority;

    await expect(taxonomyCommand(authority, [
      "sync", "--file", snapshotPath, "--request-id", "REQ-TAXONOMY-SYNC-0001"
    ])).resolves.toMatchObject({ record: { recordId: snapshot.snapshotId, version: 1 } });
    const mapped = await taxonomyCommand(authority, [
      "map-role", "--snapshot", snapshot.snapshotId, "--query", "AI engineer"
    ]) as { matches: Array<{ results: Array<{ conceptId: string; score: number }> }> };
    expect(mapped.matches[0]?.results[0]).toMatchObject({ conceptId: "esco:2512.1", score: 1 });
  });

  it("builds, persists, validates, and renders an assurance case", async () => {
    const draftPath = path.join(root, "assurance-draft.json");
    const outputPath = path.join(root, "assurance.md");
    const draft = {
      caseId: "CASE-COMMAND-001",
      createdAt: "2026-07-14T12:00:00.000Z",
      decision: {
        decisionId: "DECISION-COMMAND-001",
        routeId: "ROUTE-COMMAND-001",
        recommendation: "defer",
        statement: "Defer until current evidence is available.",
        reversibility: "R1",
        highStakes: false,
        disclosure: "public"
      },
      evidence: [{
        evidenceId: "EVIDENCE-COMMAND-001",
        claimId: "CLAIM-COMMAND-001",
        claimHash: sha256("claim"),
        sourceId: "fixture:product-command",
        sourceHash: sha256("source"),
        observedAt: "2026-07-14T11:00:00.000Z",
        freshUntil: "2026-07-15T11:00:00.000Z",
        disclosure: "public"
      }],
      uncertainties: [],
      defeaters: [],
      policies: [{
        policyId: "POLICY-COMMAND-001",
        policyVersionHash: sha256("policy"),
        outcome: "manual-review",
        rationale: "A defer recommendation preserves optionality.",
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
        principalId: "GENERATOR-COMMAND",
        componentId: "assurance-command",
        generatedAt: "2026-07-14T12:00:00.000Z"
      }
    };
    writeFileSync(draftPath, JSON.stringify(draft), "utf8");
    let stored: unknown = null;
    const request = vi.fn(async (operation: string, payload: unknown) => {
      if (operation === "assurance-case-get") return stored;
      if (operation === "assurance-case-record") {
        stored = { recordId: draft.caseId, version: 1, value: (payload as { value: unknown }).value };
        return stored;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const authority = { request } as unknown as ProductCommandAuthority;
    await assuranceCommand(authority, [
      "build", "--file", draftPath, "--request-id", "REQ-ASSURANCE-BUILD-0001"
    ], new Date("2026-07-14T12:00:00.000Z"));
    const report = await assuranceCommand(authority, [
      "report", "--id", draft.caseId, "--format", "markdown", "--output", outputPath,
      "--allow-uncertified"
    ], new Date("2026-07-14T12:00:00.000Z")) as { outputPath: string };
    expect(report.outputPath).toBe(outputPath);
    expect(readFileSync(outputPath, "utf8")).toContain("Career Assurance Case CASE-COMMAND-001");
  });

  it("keeps agent and model support reporting evidence bounded", () => {
    const agents = agentIntegrationStatus(new Date("2026-07-14T12:00:00.000Z")) as Array<{
      status: { level: string };
    }>;
    const models = modelProviderStatus() as Array<{ credentialConfigured: string; endpointHealth: string }>;
    expect(agents).toHaveLength(9);
    expect(agents.every((entry) => entry.status.level !== "verified")).toBe(true);
    expect(models).toHaveLength(11);
    expect(models.every((entry) => entry.credentialConfigured === "not-inspected")).toBe(true);
    expect(models.every((entry) => entry.endpointHealth === "not-probed")).toBe(true);
  });

  it("exposes checksum-gated agent integration lifecycle contracts", async () => {
    await expect(agentIntegrationCommand(["help"])).resolves.toMatchObject({
      policy: "explicit-target-checksum-gated-copy-only"
    });
    const manifest = await agentIntegrationCommand(["manifest", "--agent", "codex"]) as {
      manifest: { files: Array<{ path: string; sha256: string }> };
    };
    expect(manifest.manifest.files).toEqual([{
      path: "SKILL.md",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    }]);
    await expect(agentIntegrationCommand([
      "doctor", "--agent", "codex", "--target", "relative/skill"
    ])).rejects.toThrow("explicit absolute path");
  });
});
