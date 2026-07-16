import { fileURLToPath } from "node:url";
import type { VocationTransportRequest } from "@vocation-os/sdk";
import { describe, expect, it } from "vitest";
import {
  VocationCliReadTransport,
  loadVocationTransportModule,
  vocationCliReadCommand
} from "../src/cli-transport.js";

const MOCK_CLI = fileURLToPath(new URL("./fixtures/mock-vocation-cli.mjs", import.meta.url));
const MOCK_TRANSPORT = fileURLToPath(new URL("./fixtures/mock-transport.mjs", import.meta.url));

describe("VocationCliReadTransport", () => {
  it("maps every supported SDK read operation to a bounded CLI command", () => {
    const cases: Array<[VocationTransportRequest, string[]]> = [[
      { operation: "health", payload: {} },
      ["daemon-status"]
    ], [
      { operation: "domain-list", payload: { domain: "opportunities", includeArchived: true } },
      ["domain-list", "opportunities", "--all"]
    ], [
      { operation: "tracker-list", payload: {} },
      ["tracker-list"]
    ], [
      { operation: "artifact-list", payload: {} },
      ["artifact-list"]
    ], [
      { operation: "approver-list", payload: {} },
      ["approver-list"]
    ], [
      { operation: "collector-list", payload: {} },
      ["collector-list"]
    ], [
      { operation: "audit-export", payload: {} },
      ["export-audit"]
    ], [
      { operation: "credential-passport-list", payload: {} },
      ["credential", "list"]
    ], [
      { operation: "auto-apply-status", payload: {} },
      ["auto-apply-status"]
    ], [
      { operation: "onboarding-status", payload: {} },
      ["onboarding-status"]
    ]];

    for (const [request, expectedArguments] of cases) {
      expect(vocationCliReadCommand(request)).toEqual(expectedArguments);
    }
  });

  it("captures a read command and parses only its JSON response", async () => {
    const transport = new VocationCliReadTransport({ cliPath: MOCK_CLI });

    await expect(transport.execute({ operation: "health", payload: {} }))
      .resolves.toEqual({ arguments: ["daemon-status"] });
  }, 10_000);

  it("rejects every mutation before spawning the CLI", async () => {
    const transport = new VocationCliReadTransport({ cliPath: MOCK_CLI });

    await expect(transport.execute({
      operation: "tracker-submit",
      payload: { attemptId: "ATTEMPT-1", expectedVersion: 1 },
      requestId: "REQ-MCP-12345678"
    })).rejects.toThrow("Read-only CLI transport rejects mutation: tracker-submit");
  });

  it("loads an explicit SDK transport factory without importing product state", async () => {
    const transport = await loadVocationTransportModule(MOCK_TRANSPORT);

    await expect(transport.execute({ operation: "health", payload: {}, timeoutMs: 1_000 }))
      .resolves.toMatchObject({ operation: "health", payload: {}, timeoutMs: 1_000 });
  });
});
