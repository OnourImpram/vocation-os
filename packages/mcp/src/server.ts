import {
  McpPolicyError,
  READ_ONLY_TOOLS,
  SIDE_EFFECT_TOOLS,
  type JsonObject,
  type JsonValue,
  type McpScopedApproval,
  type McpToolDefinition,
  type McpToolExecutor
} from "./index.js";
import {
  McpInputError,
  assertJsonValue,
  hasOnlyKeys,
  isJsonObject,
  jsonByteLength,
  requireIsoTimestamp,
  requireString
} from "./validation.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
export const VOCATION_APPROVAL_META_KEY = "vocation-os/scoped-approval";
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 1024 * 1024;

export type JsonRpcId = string | number;

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type McpDiagnosticSink = (message: string) => void;

interface ParsedRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

interface ParsedNotification {
  method: string;
  params: unknown;
}

export interface McpProtocolServerOptions {
  executor: McpToolExecutor;
  capabilities?: readonly string[];
  diagnostic?: McpDiagnosticSink;
  maxToolResultBytes?: number;
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validRequestId(value: unknown): value is JsonRpcId {
  return typeof value === "string"
    ? value.length <= 128
    : Number.isSafeInteger(value);
}

function validMethod(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function protocolError(
  id: JsonRpcId | null,
  code: number,
  message: string
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function invalidParams(id: JsonRpcId): JsonRpcErrorResponse {
  return protocolError(id, -32602, "Invalid params");
}

function noParams(params: unknown): boolean {
  if (params === undefined) return true;
  return isJsonObject(params) && hasOnlyKeys(params, ["_meta"]);
}

function parseApproval(value: unknown): McpScopedApproval {
  if (!isJsonObject(value) || !hasOnlyKeys(value, [
    "approvalId",
    "toolName",
    "capability",
    "argumentDigest",
    "expiresAt"
  ])) {
    throw new McpInputError("Scoped approval metadata is invalid");
  }
  const argumentDigest = requireString(value["argumentDigest"], "Approval argument digest", {
    maxLength: 64,
    pattern: /^[a-f0-9]{64}$/u
  });
  return {
    approvalId: requireString(value["approvalId"], "Approval id", {
      maxLength: 128,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
    }),
    toolName: requireString(value["toolName"], "Approval tool", { maxLength: 128 }),
    capability: requireString(value["capability"], "Approval capability", { maxLength: 128 }),
    argumentDigest,
    expiresAt: requireIsoTimestamp(value["expiresAt"], "Approval expiry")
  };
}

function wireTool(tool: McpToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    execution: { taskSupport: "forbidden" },
    _meta: {
      "vocation-os/security": {
        ...tool.security,
        approvalMetaKey: tool.security.approvalRequired ? VOCATION_APPROVAL_META_KEY : null
      }
    }
  };
}

function toolError(code: string, message: string): Record<string, unknown> {
  const structuredContent = { error: { code, message } };
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
    isError: true
  };
}

function normalizeToolResult(value: unknown, maxBytes: number): Record<string, unknown> {
  assertJsonValue(value, "Tool result");
  const structuredContent: JsonObject = isJsonObject(value) ? value : { value };
  if (jsonByteLength(structuredContent) > maxBytes) {
    throw new McpInputError("Daemon result exceeded the MCP output limit");
  }
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false
  };
}

function allTool(name: string): McpToolDefinition | undefined {
  return [...READ_ONLY_TOOLS, ...SIDE_EFFECT_TOOLS].find((tool) => tool.name === name);
}

export class McpProtocolServer {
  private readonly capabilities: readonly string[];
  private readonly diagnostic: McpDiagnosticSink;
  private readonly maxToolResultBytes: number;
  private state: "pre-initialize" | "awaiting-initialized" | "ready" = "pre-initialize";

  public constructor(private readonly options: McpProtocolServerOptions) {
    this.capabilities = Object.freeze([...(options.capabilities ?? [])]);
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.maxToolResultBytes = options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
    if (
      !Number.isSafeInteger(this.maxToolResultBytes)
      || this.maxToolResultBytes < 1_024
      || this.maxToolResultBytes > 4 * 1024 * 1024
    ) {
      throw new TypeError("MCP tool result limit must be between 1024 and 4194304 bytes");
    }
  }

  private visibleTools(): readonly McpToolDefinition[] {
    return this.options.executor.listTools().filter((tool) => (
      tool.security.effect === "read"
      || (
        tool.security.requiredCapability !== null
        && this.capabilities.includes(tool.security.requiredCapability)
      )
    ));
  }

  private parseEnvelope(value: unknown): ParsedRequest | ParsedNotification | JsonRpcErrorResponse {
    if (!isJsonObject(value) || !hasOnlyKeys(value, ["jsonrpc", "id", "method", "params"])) {
      return protocolError(null, -32600, "Invalid Request");
    }
    if (value["jsonrpc"] !== "2.0" || !validMethod(value["method"])) {
      return protocolError(null, -32600, "Invalid Request");
    }
    const method = value["method"];
    const params = value["params"];
    if (!hasOwn(value, "id")) return { method, params };
    if (!validRequestId(value["id"])) return protocolError(null, -32600, "Invalid Request");
    return { id: value["id"], method, params };
  }

  private handleInitialize(request: ParsedRequest): JsonRpcResponse {
    if (this.state !== "pre-initialize" || !isJsonObject(request.params)) {
      return invalidParams(request.id);
    }
    const params = request.params;
    if (!hasOnlyKeys(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"])) {
      return invalidParams(request.id);
    }
    const protocolVersion = params["protocolVersion"];
    const clientCapabilities = params["capabilities"];
    const clientInfo = params["clientInfo"];
    if (
      typeof protocolVersion !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/u.test(protocolVersion)
      || !isJsonObject(clientCapabilities)
      || !isJsonObject(clientInfo)
      || typeof clientInfo["name"] !== "string"
      || clientInfo["name"].length === 0
      || typeof clientInfo["version"] !== "string"
      || clientInfo["version"].length === 0
    ) {
      return invalidParams(request.id);
    }
    try {
      assertJsonValue(clientCapabilities, "Client capabilities");
      assertJsonValue(clientInfo, "Client info");
    } catch {
      return invalidParams(request.id);
    }

    const negotiatedVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(protocolVersion)
      ? protocolVersion
      : MCP_PROTOCOL_VERSION;
    this.state = "awaiting-initialized";
    return success(request.id, {
      protocolVersion: negotiatedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "vocation-os",
        title: "VocationOS",
        version: "0.6.1",
        description: "Read-first local daemon tools with capability and scoped approval gates."
      },
      instructions: this.visibleTools().some((tool) => tool.security.effect === "side-effect")
        ? "Side effects are startup enabled but still require an operator granted capability and an argument bound scoped approval."
        : "This server is read-only. Side-effect tools are disabled at startup."
    });
  }

  private handleNotification(notification: ParsedNotification): void {
    if (notification.method !== "notifications/initialized") return;
    if (!noParams(notification.params)) {
      this.diagnostic("Ignored malformed notifications/initialized message");
      return;
    }
    if (this.state !== "awaiting-initialized") {
      this.diagnostic("Ignored out-of-sequence notifications/initialized message");
      return;
    }
    this.state = "ready";
  }

  private handleToolsList(request: ParsedRequest): JsonRpcResponse {
    if (request.params !== undefined) {
      if (!isJsonObject(request.params) || !hasOnlyKeys(request.params, ["cursor", "_meta"])) {
        return invalidParams(request.id);
      }
      if (hasOwn(request.params, "cursor")) return invalidParams(request.id);
    }
    return success(request.id, { tools: this.visibleTools().map(wireTool) });
  }

  private async executeTool(
    request: ParsedRequest,
    name: string,
    argumentsValue: JsonObject,
    approval: McpScopedApproval | undefined
  ): Promise<JsonRpcResponse> {
    try {
      const result = await this.options.executor.invoke(name, argumentsValue, {
        capabilities: this.capabilities,
        ...(approval ? { approval } : {})
      });
      return success(request.id, normalizeToolResult(result, this.maxToolResultBytes));
    } catch (error) {
      if (error instanceof McpPolicyError) {
        if (error.code === "unknown-tool") {
          return protocolError(request.id, -32602, `Unknown tool: ${name}`);
        }
        return success(request.id, toolError(error.code, error.message));
      }
      if (error instanceof McpInputError) {
        return success(request.id, toolError("invalid-input", error.message));
      }
      this.diagnostic(`Daemon invocation failed for ${name}`);
      return success(
        request.id,
        toolError("daemon-request-failed", "VocationOS daemon request failed or returned an invalid result.")
      );
    }
  }

  private handleToolsCall(request: ParsedRequest): Promise<JsonRpcResponse> | JsonRpcResponse {
    if (!isJsonObject(request.params) || !hasOnlyKeys(request.params, ["name", "arguments", "_meta", "task"])) {
      return invalidParams(request.id);
    }
    const params = request.params;
    const name = params["name"];
    if (
      typeof name !== "string"
      || !/^[A-Za-z0-9_.-]{1,128}$/u.test(name)
      || allTool(name) === undefined
    ) {
      return protocolError(request.id, -32602, `Unknown tool: ${typeof name === "string" ? name : "invalid"}`);
    }
    const argumentsValue = params["arguments"] ?? {};
    if (!isJsonObject(argumentsValue)) return invalidParams(request.id);
    try {
      assertJsonValue(argumentsValue, "Tool arguments");
    } catch {
      return invalidParams(request.id);
    }
    if (params["task"] !== undefined) return invalidParams(request.id);
    const metadata = params["_meta"];
    if (metadata !== undefined && !isJsonObject(metadata)) return invalidParams(request.id);

    let approval: McpScopedApproval | undefined;
    try {
      if (isJsonObject(metadata) && hasOwn(metadata, VOCATION_APPROVAL_META_KEY)) {
        approval = parseApproval(metadata[VOCATION_APPROVAL_META_KEY]);
      }
    } catch (error) {
      return success(
        request.id,
        toolError("approval-invalid", error instanceof Error ? error.message : "Scoped approval metadata is invalid")
      );
    }
    return this.executeTool(request, name, argumentsValue, approval);
  }

  private dispatchRequest(request: ParsedRequest): Promise<JsonRpcResponse> | JsonRpcResponse {
    if (request.method === "ping") {
      return noParams(request.params) ? success(request.id, {}) : invalidParams(request.id);
    }
    if (request.method === "initialize") return this.handleInitialize(request);
    if (this.state !== "ready") {
      return protocolError(request.id, -32002, "Server not initialized");
    }
    if (request.method === "tools/list") return this.handleToolsList(request);
    if (request.method === "tools/call") return this.handleToolsCall(request);
    return protocolError(request.id, -32601, "Method not found");
  }

  private handleValue(value: unknown): Promise<JsonRpcResponse | null> {
    const envelope = this.parseEnvelope(value);
    if ("error" in envelope) return Promise.resolve(envelope);
    if (!("id" in envelope)) {
      this.handleNotification(envelope);
      return Promise.resolve(null);
    }
    return Promise.resolve(this.dispatchRequest(envelope)).catch(() => {
      this.diagnostic(`Internal request failure for ${envelope.method}`);
      return protocolError(envelope.id, -32603, "Internal error");
    });
  }

  public handleFrame(frame: Uint8Array): Promise<JsonRpcResponse | null> {
    let serialized: string;
    try {
      serialized = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      return Promise.resolve(protocolError(null, -32700, "Parse error"));
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      return Promise.resolve(protocolError(null, -32700, "Parse error"));
    }
    return this.handleValue(value);
  }
}
