import { describe, expect, it } from "vitest";
import { decideModelEgress, executeModelInvocation, modelEndpointHash, type ModelInvocationIntent } from "../../src/models/index.js";
import { sha256 } from "../../src/hash.js";

function remoteIntent(): ModelInvocationIntent {
  return {
    invocationId: "MODEL-INV-001",
    providerId: "openai",
    endpoint: "https://api.openai.com",
    modelId: "configured-model",
    purpose: "career-fit-analysis",
    dataCategories: ["public-opportunity", "profile-claims"],
    redactionPreview: ["contact fields removed", "private constraints excluded"],
    payloadHashes: [sha256("redacted opportunity")],
    retentionStatement: "Provider retention reviewed by the operator",
    approval: {
      approvalId: "APR-MODEL-001",
      invocationId: "MODEL-INV-001",
      providerId: "openai",
      approvedBy: "operator",
      approvedAt: "2026-07-14T09:00:00.000Z",
      expiresAt: "2026-07-14T11:00:00.000Z",
      allowedPurposes: ["career-fit-analysis"],
      allowedDataCategories: ["public-opportunity", "profile-claims"],
      allowedModelIds: ["configured-model"],
      endpointHash: modelEndpointHash("https://api.openai.com"),
      retentionAcknowledged: true,
      approvalTextHash: sha256("approved redacted fit analysis")
    }
  };
}

describe("model gateway", () => {
  it("allows loopback local models without a remote egress approval", () => {
    const intent: ModelInvocationIntent = {
      ...remoteIntent(),
      providerId: "ollama",
      endpoint: "http://127.0.0.1:11434",
      approval: null,
      retentionStatement: null
    };
    expect(decideModelEgress(intent, new Date("2026-07-14T10:00:00.000Z")).allowed).toBe(true);
  });

  it("blocks remote invocation without scoped approval", () => {
    const decision = decideModelEgress({ ...remoteIntent(), approval: null }, new Date("2026-07-14T10:00:00.000Z"));
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain("model-egress-approval-missing");
  });

  it("blocks approval reuse for another data category", () => {
    const decision = decideModelEgress({
      ...remoteIntent(),
      dataCategories: ["credential-metadata"]
    }, new Date("2026-07-14T10:00:00.000Z"));
    expect(decision.blockedBy).toContain("model-egress-data-category-not-approved");
  });

  it("blocks approval replay against another invocation, endpoint, or model", () => {
    const invocationMismatch = decideModelEgress({ ...remoteIntent(), invocationId: "MODEL-INV-002" }, new Date("2026-07-14T10:00:00.000Z"));
    expect(invocationMismatch.blockedBy).toContain("model-egress-approval-invocation-mismatch");

    const endpointMismatch = decideModelEgress({ ...remoteIntent(), endpoint: "https://example.com" }, new Date("2026-07-14T10:00:00.000Z"));
    expect(endpointMismatch.blockedBy).toContain("model-endpoint-host-not-allowed");
    expect(endpointMismatch.blockedBy).toContain("model-egress-approval-endpoint-mismatch");

    const modelMismatch = decideModelEgress({ ...remoteIntent(), modelId: "other-model" }, new Date("2026-07-14T10:00:00.000Z"));
    expect(modelMismatch.blockedBy).toContain("model-egress-model-not-approved");
  });

  it("rejects localhost names for local providers instead of trusting DNS", () => {
    const decision = decideModelEgress({
      ...remoteIntent(),
      providerId: "ollama",
      endpoint: "http://localhost:11434",
      approval: null,
      retentionStatement: null
    }, new Date("2026-07-14T10:00:00.000Z"));
    expect(decision.blockedBy).toContain("local-model-endpoint-not-loopback");
  });

  it("executes only after the deterministic gate and emits hashed receipts", async () => {
    const response = await executeModelInvocation({
      intent: remoteIntent(),
      messages: [{ role: "user", content: "redacted opportunity" }],
      temperature: 0,
      maximumOutputTokens: 256
    }, {
      invoke: async () => ({ text: "bounded analysis", inputTokens: 4, outputTokens: 2 })
    }, new Date("2026-07-14T10:00:00.000Z"));
    expect(response.text).toBe("bounded analysis");
    expect(response.receipt.requestHash).toMatch(/^sha256:/);
    expect(response.receipt.responseHash).toBe(sha256("bounded analysis"));
  });

  it("rejects an approved intent when the transported message bytes change", async () => {
    await expect(executeModelInvocation({
      intent: remoteIntent(),
      messages: [{ role: "user", content: "different private payload" }],
      temperature: 0,
      maximumOutputTokens: 256
    }, {
      invoke: async () => ({ text: "must not run" })
    }, new Date("2026-07-14T10:00:00.000Z"))).rejects.toThrow("approved intent hashes");
  });

  it("bounds request, response, token, and usage surfaces", async () => {
    await expect(executeModelInvocation({
      intent: remoteIntent(),
      messages: [{ role: "user", content: "redacted opportunity" }],
      temperature: 0,
      maximumOutputTokens: 131_073
    }, {
      invoke: async () => ({ text: "must not run" })
    }, new Date("2026-07-14T10:00:00.000Z"))).rejects.toThrow("between 1 and 131072");

    await expect(executeModelInvocation({
      intent: remoteIntent(),
      messages: [{ role: "user", content: "redacted opportunity" }],
      temperature: 0,
      maximumOutputTokens: 256
    }, {
      invoke: async () => ({ text: "bounded", inputTokens: -1 })
    }, new Date("2026-07-14T10:00:00.000Z"))).rejects.toThrow("invalid inputTokens");
  });
});
