import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAdvisoryPrompt,
  createRemoteClient,
  createRemoteClientFromEnv,
  type AdvisoryContext
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

function legacyOptions() {
  return {
    endpoint: "https://advisor.example.test/v1/complete",
    apiKey: "test-secret-not-real",
    model: "test-model",
    allowedHosts: ["advisor.example.test"]
  };
}

describe("remote advisory boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed instead of constructing the legacy remote transport", () => {
    expect(() => createRemoteClient(legacyOptions())).toThrow("governed model gateway");
  });

  it("returns no remote client when the legacy environment is absent", () => {
    vi.stubEnv("ADVISOR_ENDPOINT", "");
    vi.stubEnv("ADVISOR_API_KEY", "");
    vi.stubEnv("ADVISOR_MODEL", "");
    expect(createRemoteClientFromEnv()).toBeNull();
  });

  it("fails closed when legacy remote environment variables are configured", () => {
    vi.stubEnv("ADVISOR_ENDPOINT", "https://advisor.example.test/v1/complete");
    vi.stubEnv("ADVISOR_API_KEY", "test-secret-not-real");
    vi.stubEnv("ADVISOR_MODEL", "test-model");
    expect(() => createRemoteClientFromEnv()).toThrow("governed model gateway");
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

});
