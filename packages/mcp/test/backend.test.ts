import { VocationClient, type VocationTransportRequest } from "@vocation-os/sdk";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VocationSdkBackend } from "../src/backend.js";
import {
  McpToolExecutor,
  createMcpArgumentDigest,
  type JsonObject
} from "../src/index.js";

describe("VocationSdkBackend", () => {
  it("routes read tools only through the typed SDK client", async () => {
    const requests: VocationTransportRequest[] = [];
    const client = new VocationClient({
      execute: vi.fn(async (request: VocationTransportRequest) => {
        requests.push(request);
        return { operation: request.operation, payload: request.payload };
      })
    });
    const executor = new McpToolExecutor({ backend: new VocationSdkBackend(client) });

    const result = await executor.invoke("vocation_today", {});

    expect(requests.map((request) => request.operation)).toEqual([
      "health",
      "domain-list",
      "tracker-list",
      "domain-list"
    ]);
    expect(result).toMatchObject({
      authority: "vocationd",
      tool: "vocation_today",
      readOnly: true
    });
  });

  it("maps every remaining read catalog route to bounded authority operations", async () => {
    const requests: VocationTransportRequest[] = [];
    const executor = new McpToolExecutor({
      backend: new VocationSdkBackend(new VocationClient({
        execute: async (request) => {
          requests.push(request);
          return { operation: request.operation };
        }
      }))
    });
    const cases: Array<[string, string[]]> = [
      ["vocation_health", ["health"]],
      ["vocation_discovery", ["domain-list"]],
      ["vocation_review", ["domain-list", "domain-list"]],
      ["vocation_twin", ["domain-list"]],
      ["vocation_documents", ["domain-list"]],
      ["vocation_pipeline", ["tracker-list"]],
      ["vocation_evidence", ["artifact-list"]],
      ["vocation_approvals", ["approver-list"]],
      ["vocation_audit", ["audit-export"]],
      ["vocation_credentials", ["credential-passport-list"]],
      ["vocation_interview", ["domain-list"]],
      ["vocation_offers", ["domain-list"]],
      ["vocation_settings", ["health", "auto-apply-status", "onboarding-status"]]
    ];

    for (const [tool, operations] of cases) {
      requests.length = 0;
      await executor.invoke(tool, {});
      expect(requests.map((request) => request.operation), tool).toEqual(operations);
      if (tool === "vocation_audit") expect(requests[0]?.timeoutMs).toBe(30_000);
    }
  });

  it("uses an approval-bound deterministic daemon request id for mutations", async () => {
    const requests: VocationTransportRequest[] = [];
    const client = new VocationClient({
      execute: vi.fn(async (request: VocationTransportRequest) => {
        requests.push(request);
        return { accepted: true };
      })
    });
    const executor = new McpToolExecutor({
      backend: new VocationSdkBackend(client),
      enableSideEffects: true
    });
    const argumentsValue: JsonObject = { attemptId: "ATTEMPT-1", expectedVersion: 4 };
    const context = {
      capabilities: ["submission.request"],
      approval: {
        approvalId: "APPROVAL-1",
        toolName: "vocation_request_submission",
        capability: "submission.request",
        argumentDigest: createMcpArgumentDigest(argumentsValue),
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      now: new Date("2026-07-14T12:00:00.000Z")
    } as const;

    await executor.invoke("vocation_request_submission", argumentsValue, context);
    await executor.invoke("vocation_request_submission", argumentsValue, context);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      operation: "tracker-submit",
      payload: argumentsValue,
      requestId: expect.stringMatching(/^REQ-MCP-[a-f0-9]{48}$/u)
    });
    expect(requests[1]?.requestId).toBe(requests[0]?.requestId);
  });

  it("creates schema-compatible deterministic approval review tasks", async () => {
    const requests: VocationTransportRequest[] = [];
    const executor = new McpToolExecutor({
      backend: new VocationSdkBackend(new VocationClient({
        execute: async (request) => {
          requests.push(request);
          return { accepted: true };
        }
      })),
      enableSideEffects: true
    });
    const argumentsValue: JsonObject = {
      attemptId: "ATTEMPT-APPROVAL",
      requestedAt: "2026-07-14T12:00:00.000Z",
      dueAt: "2026-07-15T12:00:00.000Z",
      priority: 2
    };

    await executor.invoke("vocation_request_approval", argumentsValue, {
      capabilities: ["approval.request"],
      approval: {
        approvalId: "APPROVAL-TASK-1",
        toolName: "vocation_request_approval",
        capability: "approval.request",
        argumentDigest: createMcpArgumentDigest(argumentsValue),
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    });

    const payload = requests[0]?.payload as { domain?: unknown; value?: { taskId?: unknown } };
    expect(requests[0]).toMatchObject({ operation: "domain-put" });
    expect(payload).toMatchObject({ domain: "tasks" });
    expect(payload.value?.taskId).toMatch(/^TSK-APPROVAL-[A-F0-9]{24}$/u);
  });

  it("routes each supported pipeline and credential mutation with its scoped request identity", async () => {
    const requests: VocationTransportRequest[] = [];
    const executor = new McpToolExecutor({
      backend: new VocationSdkBackend(new VocationClient({
        execute: async (request) => {
          requests.push(request);
          return { accepted: true };
        }
      })),
      enableSideEffects: true
    });
    const cases: Array<{
      tool: "vocation_update_pipeline" | "vocation_update_credentials";
      capability: "pipeline.update" | "credentials.update";
      argumentsValue: JsonObject;
      operation: string;
    }> = [{
      tool: "vocation_update_pipeline",
      capability: "pipeline.update",
      argumentsValue: { action: "create", input: { attemptId: "ATTEMPT-CREATE" } },
      operation: "tracker-create"
    }, {
      tool: "vocation_update_pipeline",
      capability: "pipeline.update",
      argumentsValue: {
        action: "approve",
        attemptId: "ATTEMPT-APPROVE",
        expectedVersion: 1,
        approval: { approvalId: "DAEMON-APPROVAL" }
      },
      operation: "tracker-approve"
    }, {
      tool: "vocation_update_pipeline",
      capability: "pipeline.update",
      argumentsValue: {
        action: "block",
        attemptId: "ATTEMPT-BLOCK",
        expectedVersion: 2,
        blocker: "Operator blocked"
      },
      operation: "tracker-block"
    }, {
      tool: "vocation_update_pipeline",
      capability: "pipeline.update",
      argumentsValue: {
        action: "confirm",
        attemptId: "ATTEMPT-CONFIRM",
        expectedVersion: 3,
        proof: { proofId: "PROOF-1" }
      },
      operation: "tracker-confirm"
    }, {
      tool: "vocation_update_credentials",
      capability: "credentials.update",
      argumentsValue: { action: "record-mapping", value: { mappingId: "MAP-1" }, expectedVersion: 0 },
      operation: "credential-mapping-record"
    }];

    for (const testCase of cases) {
      requests.length = 0;
      await executor.invoke(testCase.tool, testCase.argumentsValue, {
        capabilities: [testCase.capability],
        approval: {
          approvalId: `APPROVAL-${testCase.operation}`,
          toolName: testCase.tool,
          capability: testCase.capability,
          argumentDigest: createMcpArgumentDigest(testCase.argumentsValue),
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        operation: testCase.operation,
        requestId: expect.stringMatching(/^REQ-MCP-[a-f0-9]{48}$/u)
      });
    }

    requests.length = 0;
    const importArguments: JsonObject = {
      action: "import-passport",
      sourcePath: path.resolve("credential.json"),
      format: "json",
      expectedSubjectId: null,
      importedAt: "2026-07-14T12:00:00.000Z",
      expectedVersion: 0
    };
    await executor.invoke("vocation_update_credentials", importArguments, {
      capabilities: ["credentials.update"],
      approval: {
        approvalId: "APPROVAL-CREDENTIAL-IMPORT",
        toolName: "vocation_update_credentials",
        capability: "credentials.update",
        argumentDigest: createMcpArgumentDigest(importArguments),
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ operation: "artifact-import", requestId: expect.stringMatching(/^REQ-MCP-[a-f0-9]{48}$/u) });
    expect(requests[1]).toMatchObject({ operation: "credential-import-artifact", requestId: expect.stringMatching(/^REQ-MCP-[a-f0-9]{48}$/u) });
    expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
  });

  it("fails closed on unsupported pipeline transitions before transport execution", async () => {
    const execute = vi.fn(async () => ({}));
    const executor = new McpToolExecutor({
      backend: new VocationSdkBackend(new VocationClient({ execute })),
      enableSideEffects: true
    });
    const argumentsValue: JsonObject = { action: "submit" };

    await expect(executor.invoke("vocation_update_pipeline", argumentsValue, {
      capabilities: ["pipeline.update"],
      approval: {
        approvalId: "APPROVAL-PIPELINE-1",
        toolName: "vocation_update_pipeline",
        capability: "pipeline.update",
        argumentDigest: createMcpArgumentDigest(argumentsValue),
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    })).rejects.toThrow("Pipeline action must be create, approve, block, or confirm");
    expect(execute).not.toHaveBeenCalled();
  });
});
