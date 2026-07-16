import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMcpArgumentDigest, type JsonObject } from "../src/index.js";
import { MCP_PROTOCOL_VERSION, VOCATION_APPROVAL_META_KEY } from "../src/server.js";

const BIN_PATH = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const TRANSPORT_MODULE = fileURLToPath(new URL("./fixtures/mock-transport.mjs", import.meta.url));

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runServer(argumentsValue: readonly string[], input: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...argumentsValue], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      forceTimer.unref();
    }, 5_000);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new Error("MCP subprocess did not close within five seconds"));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function requestLines(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function responses(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().length === 0
    ? []
    : stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a record");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array");
  return value;
}

function byId(messages: Array<Record<string, unknown>>, id: string | number): Record<string, unknown> {
  const response = messages.find((message) => message["id"] === id);
  if (!response) throw new Error(`Missing response ${String(id)}`);
  return response;
}

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "subprocess-smoke", version: "1.0.0" }
    }
  };
}

describe("vocation-mcp subprocess", () => {
  it("serves initialize, initialized, ping, tools/list, and a daemon-backed read call", async () => {
    const result = await runServer(["--sdk-transport-module", TRANSPORT_MODULE], requestLines([
      initializeRequest(),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "ping", method: "ping" },
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: "health",
        method: "tools/call",
        params: { name: "vocation_health", arguments: {} }
      }
    ]));
    const messages = responses(result.stdout);
    const tools = array(record(byId(messages, "list")["result"])["tools"]);
    const health = record(record(byId(messages, "health")["result"])["structuredContent"]);

    expect(result).toMatchObject({ code: 0, signal: null });
    expect(messages).toHaveLength(4);
    expect(messages.every((message) => message["jsonrpc"] === "2.0")).toBe(true);
    expect(byId(messages, "ping")).toMatchObject({ result: {} });
    expect(tools).toHaveLength(14);
    expect(record(health["data"])).toMatchObject({ operation: "health", payload: {} });
    expect(result.stdout).not.toContain("vocation-mcp");
    expect(result.stderr).toContain("[vocation-mcp] started in read-only mode");
  });

  it("executes a side effect only with flag, capability, and scoped approval", async () => {
    const argumentsValue: JsonObject = { attemptId: "ATTEMPT-SMOKE", expectedVersion: 3 };
    const result = await runServer([
      "--sdk-transport-module",
      TRANSPORT_MODULE,
      "--enable-side-effects",
      "--capability",
      "submission.request"
    ], requestLines([
      initializeRequest(),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: "submit",
        method: "tools/call",
        params: {
          name: "vocation_request_submission",
          arguments: argumentsValue,
          _meta: {
            [VOCATION_APPROVAL_META_KEY]: {
              approvalId: "APPROVAL-SMOKE",
              toolName: "vocation_request_submission",
              capability: "submission.request",
              argumentDigest: createMcpArgumentDigest(argumentsValue),
              expiresAt: "2099-01-01T00:00:00.000Z"
            }
          }
        }
      }
    ]));
    const messages = responses(result.stdout);
    const tools = array(record(byId(messages, "list")["result"])["tools"]);
    const submission = record(record(byId(messages, "submit")["result"])["structuredContent"]);

    expect(result.code).toBe(0);
    expect(tools).toHaveLength(15);
    expect(tools).toContainEqual(expect.objectContaining({ name: "vocation_request_submission" }));
    expect(tools).not.toContainEqual(expect.objectContaining({ name: "vocation_update_credentials" }));
    expect(submission["authorityRequestId"]).toMatch(/^REQ-MCP-[a-f0-9]{48}$/u);
    expect(record(submission["data"])).toMatchObject({
      operation: "tracker-submit",
      payload: argumentsValue,
      requestId: submission["authorityRequestId"]
    });
    expect(result.stderr).toContain("started with 1 mutation capability grant(s)");
  });

  it("refuses side-effect startup without a mutation-capable SDK transport", async () => {
    const result = await runServer([
      "--enable-side-effects",
      "--capability",
      "submission.request"
    ], "");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Side effects require an explicit --sdk-transport-module");
  });
});
