import { describe, expect, it, vi } from "vitest";
import {
  McpToolExecutor,
  createMcpArgumentDigest,
  type JsonObject
} from "../src/index.js";
import {
  MCP_PROTOCOL_VERSION,
  McpProtocolServer,
  VOCATION_APPROVAL_META_KEY,
  type JsonRpcResponse
} from "../src/server.js";

function encoded(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a record");
  }
  return value as Record<string, unknown>;
}

async function initialize(server: McpProtocolServer): Promise<void> {
  const response = await server.handleFrame(encoded({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" }
    }
  }));
  expect(response).toMatchObject({ id: "init", result: { protocolVersion: MCP_PROTOCOL_VERSION } });
  await expect(server.handleFrame(encoded({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }))).resolves.toBeNull();
}

function callRequest(id: JsonRpcResponse["id"], name: string, argumentsValue: JsonObject = {}, meta?: JsonObject) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: argumentsValue,
      ...(meta ? { _meta: meta } : {})
    }
  };
}

describe("McpProtocolServer", () => {
  it("enforces lifecycle and publishes only the enabled catalog", async () => {
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({ backend: { invoke: async () => ({ ok: true }) } })
    });

    await expect(server.handleFrame(encoded({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    }))).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32002, message: "Server not initialized" }
    });

    await initialize(server);
    const list = await server.handleFrame(encoded({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const tools = record(record(list)["result"])["tools"] as Array<Record<string, unknown>>;

    expect(tools).toHaveLength(14);
    expect(tools.every((tool) => record(tool["annotations"])["readOnlyHint"] === true)).toBe(true);
    expect(tools[0]).toMatchObject({
      execution: { taskSupport: "forbidden" },
      _meta: { "vocation-os/security": { effect: "read", approvalRequired: false } }
    });
    await expect(server.handleFrame(encoded({ jsonrpc: "2.0", id: 3, method: "ping" })))
      .resolves.toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("returns exact JSON-RPC protocol error shapes for malformed input", async () => {
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({ backend: { invoke: async () => ({}) } })
    });

    await expect(server.handleFrame(Buffer.from("{", "utf8"))).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" }
    });
    await expect(server.handleFrame(encoded([]))).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" }
    });
    await expect(server.handleFrame(encoded({
      jsonrpc: "2.0",
      id: 9,
      method: "ping",
      extra: true
    }))).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" }
    });

    await initialize(server);
    await expect(server.handleFrame(encoded({ jsonrpc: "2.0", id: "missing", method: "missing" })))
      .resolves.toEqual({
        jsonrpc: "2.0",
        id: "missing",
        error: { code: -32601, message: "Method not found" }
      });
    await expect(server.handleFrame(encoded(callRequest("tool", "not_a_tool"))))
      .resolves.toEqual({
        jsonrpc: "2.0",
        id: "tool",
        error: { code: -32602, message: "Unknown tool: not_a_tool" }
      });
  });

  it("rejects task-augmented calls because every tool forbids task support", async () => {
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({ backend: { invoke: async () => ({ ok: true }) } })
    });
    await initialize(server);

    await expect(server.handleFrame(encoded({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "vocation_health",
        arguments: {},
        task: { ttl: 60_000 }
      }
    }))).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "Invalid params" }
    });
  });

  it("never executes requests sent as notifications", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({ backend: { invoke } })
    });
    await initialize(server);

    await expect(server.handleFrame(encoded({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "vocation_health", arguments: {} }
    }))).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires startup capability and an argument-bound approval for side effects", async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    const argumentsValue: JsonObject = { attemptId: "ATTEMPT-9", expectedVersion: 2 };
    const executor = new McpToolExecutor({
      backend: { invoke },
      enableSideEffects: true
    });
    const server = new McpProtocolServer({
      executor,
      capabilities: ["submission.request"]
    });
    await initialize(server);

    const denied = await server.handleFrame(encoded(callRequest(1, "vocation_request_submission", argumentsValue)));
    expect(record(record(denied)["result"])["isError"]).toBe(true);
    expect(record(record(record(denied)["result"])["structuredContent"])["error"])
      .toMatchObject({ code: "approval-required" });

    const approval = {
      approvalId: "APPROVAL-9",
      toolName: "vocation_request_submission",
      capability: "submission.request",
      argumentDigest: createMcpArgumentDigest(argumentsValue),
      expiresAt: "2099-01-01T00:00:00.000Z"
    };
    const accepted = await server.handleFrame(encoded(callRequest(
      2,
      "vocation_request_submission",
      argumentsValue,
      { [VOCATION_APPROVAL_META_KEY]: approval }
    )));

    expect(record(record(accepted)["result"])["isError"]).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      authorization: { capability: "submission.request", approvalId: "APPROVAL-9" }
    }));
  });

  it("keeps daemon failures inside tool results and diagnostics off protocol data", async () => {
    const diagnostics: string[] = [];
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({
        backend: { invoke: async () => { throw new Error("private daemon detail"); } }
      }),
      diagnostic: (message) => diagnostics.push(message)
    });
    await initialize(server);

    const response = await server.handleFrame(encoded(callRequest(7, "vocation_health")));
    const result = record(record(response)["result"]);

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).not.toContain("private daemon detail");
    expect(diagnostics).toEqual(["Daemon invocation failed for vocation_health"]);
  });
});
