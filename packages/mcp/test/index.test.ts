import { describe, expect, it, vi } from "vitest";
import {
  McpPolicyError,
  McpToolExecutor,
  createMcpArgumentDigest,
  createMcpToolCatalog,
  type JsonObject
} from "../src/index.js";

describe("MCP policy", () => {
  it("is read-only by default", () => {
    const tools = createMcpToolCatalog();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.security.effect === "read")).toBe(true);
  });

  it("requires an exact capability and argument-bound approval for side effects", async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    const executor = new McpToolExecutor({ backend: { invoke }, enableSideEffects: true });
    const argumentsValue: JsonObject = { attemptId: "ATTEMPT-1", expectedVersion: 3 };

    await expect(executor.invoke("vocation_request_submission", argumentsValue, {
      capabilities: ["submission.request"]
    })).rejects.toMatchObject({ code: "approval-required" } satisfies Partial<McpPolicyError>);

    await expect(executor.invoke("vocation_request_submission", argumentsValue, {
      capabilities: ["submission.request"],
      approval: {
        approvalId: "APPROVAL-1",
        toolName: "vocation_request_submission",
        capability: "submission.request",
        argumentDigest: createMcpArgumentDigest(argumentsValue),
        expiresAt: "2026-07-15T00:00:00.000Z"
      },
      now: new Date("2026-07-14T12:00:00.000Z")
    })).resolves.toEqual({ accepted: true });

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      authorization: {
        capability: "submission.request",
        approvalId: "APPROVAL-1"
      }
    }));
  });

  it("does not expose side effects when they are disabled", async () => {
    const executor = new McpToolExecutor({ backend: { invoke: async () => ({}) } });
    await expect(executor.invoke("vocation_update_pipeline", {}))
      .rejects.toMatchObject({ code: "side-effects-disabled" } satisfies Partial<McpPolicyError>);
  });

  it("rejects non-canonical approval expiry timestamps", async () => {
    const executor = new McpToolExecutor({
      backend: { invoke: async () => ({}) },
      enableSideEffects: true
    });
    const argumentsValue: JsonObject = { attemptId: "ATTEMPT-2", expectedVersion: 1 };

    await expect(executor.invoke("vocation_request_submission", argumentsValue, {
      capabilities: ["submission.request"],
      approval: {
        approvalId: "APPROVAL-2",
        toolName: "vocation_request_submission",
        capability: "submission.request",
        argumentDigest: createMcpArgumentDigest(argumentsValue),
        expiresAt: "2099-01-01"
      }
    })).rejects.toMatchObject({ code: "approval-invalid" } satisfies Partial<McpPolicyError>);
  });
});
