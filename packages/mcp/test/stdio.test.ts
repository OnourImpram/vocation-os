import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { McpToolExecutor } from "../src/index.js";
import { MCP_PROTOCOL_VERSION, McpProtocolServer } from "../src/server.js";
import { runMcpStdio } from "../src/stdio.js";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function runInput(
  server: McpProtocolServer,
  inputValue: string | Buffer,
  maxRequestBytes = 4_096
): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const running = runMcpStdio(server, { input, output, maxRequestBytes });
  input.end(inputValue);
  await running;
  return stdout.trim().length === 0
    ? []
    : stdout.trim().split("\n").map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

describe("MCP stdio framing", () => {
  it("processes a final frame at graceful EOF without requiring a trailing newline", async () => {
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({ backend: { invoke: async () => ({}) } })
    });
    const responses = await runInput(
      server,
      JSON.stringify({ jsonrpc: "2.0", id: "eof", method: "ping" })
    );

    expect(responses).toEqual([{ jsonrpc: "2.0", id: "eof", result: {} }]);
  });

  it("rejects an oversized frame, recovers at the delimiter, and processes the next frame", async () => {
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({ backend: { invoke: async () => ({}) } })
    });
    const responses = await runInput(
      server,
      `${"x".repeat(1_025)}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}`,
      1_024
    );

    expect(responses).toHaveLength(2);
    expect(responses).toContainEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Request too large" }
    });
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  it("rejects invalid UTF-8 as a parse error", async () => {
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({ backend: { invoke: async () => ({}) } })
    });
    const responses = await runInput(server, Buffer.from([0xff, 0x0a]));

    expect(responses).toEqual([{
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" }
    }]);
  });

  it("awaits in-flight tool calls before completing EOF shutdown", async () => {
    const server = new McpProtocolServer({
      executor: new McpToolExecutor({
        backend: {
          invoke: async () => new Promise((resolve) => {
            setTimeout(() => resolve({ healthy: true }), 20);
          })
        }
      })
    });
    const inputValue = [
      line({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stdio-test", version: "1.0.0" }
        }
      }),
      line({ jsonrpc: "2.0", method: "notifications/initialized" }),
      line({
        jsonrpc: "2.0",
        id: "tool",
        method: "tools/call",
        params: { name: "vocation_health", arguments: {} }
      })
    ].join("");

    const responses = await runInput(server, inputValue);
    expect(responses.map((response) => response["id"])).toEqual(["init", "tool"]);
    expect(responses[1]).toMatchObject({ result: { isError: false } });
  });
});
