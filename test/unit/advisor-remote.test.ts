import { describe, expect, it, vi } from "vitest";
import {
  buildAdvisoryPrompt,
  createRemoteClient,
  generateAdvisoryNote,
  type AdvisoryContext,
  type LlmClient
} from "../../src/advisor.js";
import { demoGraph } from "../fixtures.js";

function context(overrides: Partial<AdvisoryContext> = {}): AdvisoryContext {
  return {
    mode: "/deep-fit",
    opportunityId: "OPP-DEMO-001",
    opportunitySummary: "A public synthetic role description.",
    claimGraph: demoGraph(),
    reversibilityTag: "R0",
    dataClassification: "public",
    remoteEgressApproved: true,
    ...overrides
  };
}

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

function remoteClient(fetchImpl: typeof fetch): LlmClient {
  return createRemoteClient({
    endpoint: "https://advisor.example.test/v1/complete",
    apiKey: "test-secret-not-real",
    model: "test-model",
    allowedHosts: ["advisor.example.test"],
    fetchImpl
  });
}

describe("remote advisory boundary", () => {
  it("requires an allowlisted endpoint host", () => {
    expect(() =>
      createRemoteClient({
        endpoint: "https://advisor.example.test/v1/complete",
        apiKey: "test-secret-not-real",
        model: "test-model",
        allowedHosts: ["different.example.test"]
      })
    ).toThrow("not allowlisted");
  });

  it("rejects insecure non localhost endpoints", () => {
    expect(() =>
      createRemoteClient({
        endpoint: "http://advisor.example.test/v1/complete",
        apiKey: "test-secret-not-real",
        model: "test-model",
        allowedHosts: ["advisor.example.test"]
      })
    ).toThrow("must use HTTPS");
  });

  it("requires explicit public egress approval before calling fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = remoteClient(fetchImpl);
    await expect(generateAdvisoryNote(client, context({ dataClassification: "sensitive" }))).rejects.toThrow("explicit egress approval");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("excludes private and unverified claims from a remote prompt", () => {
    const graph = demoGraph();
    graph.claims.push({
      ...graph.claims[0]!,
      claimId: "CLM-PRIVATE-001",
      text: "Private operator detail",
      evidenceStatus: "unverified",
      publiclyAssertable: false
    });
    const prompt = buildAdvisoryPrompt(context({ claimGraph: graph }));
    expect(prompt).toContain("CLM-DEMO-001");
    expect(prompt).not.toContain("CLM-PRIVATE-001");
    expect(prompt).not.toContain("Private operator detail");
  });

  it("sends only through a no redirect JSON request", async () => {
    const note = {
      noteId: "ADV-REMOTE-001",
      mode: "/deep-fit",
      advisoryOnly: true,
      reversibilityTag: "R0",
      narrative: "Review the evidence and preserve option value.",
      theoryIds: ["PEFIT"],
      citedClaimIds: ["CLM-DEMO-001"],
      disclaimers: [],
      generatedAt: "2026-07-10T00:00:00.000Z"
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ accept: "application/json" });
      return response(JSON.stringify({ text: JSON.stringify(note) }));
    };
    const result = await generateAdvisoryNote(remoteClient(fetchImpl), context());
    expect(result.note.reversibilityTag).toBe("R0");
    expect(result.clientName).toBe("remote-endpoint");
  });

  it("rejects a non JSON response", async () => {
    const fetchImpl: typeof fetch = async () => response("plain text", { headers: { "content-type": "text/plain" } });
    await expect(generateAdvisoryNote(remoteClient(fetchImpl), context())).rejects.toThrow("must return application/json");
  });

  it("rejects an oversized response", async () => {
    const fetchImpl: typeof fetch = async () => response(JSON.stringify({ text: "x".repeat(5000) }));
    const client = createRemoteClient({
      endpoint: "https://advisor.example.test/v1/complete",
      apiKey: "test-secret-not-real",
      model: "test-model",
      allowedHosts: ["advisor.example.test"],
      maxResponseBytes: 100,
      fetchImpl
    });
    await expect(generateAdvisoryNote(client, context())).rejects.toThrow("byte limit");
  });
});
