import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolSecurity {
  effect: "read" | "side-effect";
  requiredCapability: string | null;
  approvalRequired: boolean;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
  annotations: McpToolAnnotations;
  security: McpToolSecurity;
}

const EMPTY_INPUT = Object.freeze({ type: "object", additionalProperties: false });
const OBJECT_OUTPUT = Object.freeze({ type: "object", additionalProperties: true });
const IDENTIFIER_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
});
const VERSION_SCHEMA = Object.freeze({ type: "integer", minimum: 0 });
const OPEN_OBJECT_SCHEMA = Object.freeze({ type: "object", additionalProperties: true });

function readTool(name: string, title: string, description: string): McpToolDefinition {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema: EMPTY_INPUT,
    outputSchema: OBJECT_OUTPUT,
    annotations: Object.freeze({
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }),
    security: Object.freeze({
      effect: "read",
      requiredCapability: null,
      approvalRequired: false
    })
  });
}

function sideEffectTool(input: {
  name: string;
  title: string;
  description: string;
  capability: string;
  destructive: boolean;
  inputSchema: Readonly<Record<string, unknown>>;
  openWorld: boolean;
}): McpToolDefinition {
  return Object.freeze({
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: OBJECT_OUTPUT,
    annotations: Object.freeze({
      title: input.title,
      readOnlyHint: false,
      destructiveHint: input.destructive,
      idempotentHint: false,
      openWorldHint: input.openWorld
    }),
    security: Object.freeze({
      effect: "side-effect",
      requiredCapability: input.capability,
      approvalRequired: true
    })
  });
}

export const READ_ONLY_TOOLS = Object.freeze([
  readTool("vocation_health", "VocationOS Health", "Read daemon and provider health."),
  readTool("vocation_today", "Today", "Read the current work queue and decision summary."),
  readTool("vocation_discovery", "Discovery", "Read discovered opportunities and provenance."),
  readTool("vocation_review", "Review", "Read opportunity review material."),
  readTool("vocation_twin", "Twin", "Read the career digital twin."),
  readTool("vocation_documents", "Documents", "Read document metadata and verification state."),
  readTool("vocation_pipeline", "Pipeline", "Read application pipeline state."),
  readTool("vocation_evidence", "Evidence", "Read evidence bindings and claim status."),
  readTool("vocation_approvals", "Approvals", "Read approval state and expiry."),
  readTool("vocation_audit", "Audit", "Read the bounded audit trail."),
  readTool("vocation_credentials", "Credentials", "Read redacted credential health and metadata."),
  readTool("vocation_interview", "Interview", "Read interview preparation material."),
  readTool("vocation_offers", "Offers", "Read offer comparison material."),
  readTool("vocation_settings", "Settings", "Read effective non-secret settings.")
] satisfies readonly McpToolDefinition[]);

export const SIDE_EFFECT_TOOLS = Object.freeze([
  sideEffectTool({
    name: "vocation_request_approval",
    title: "Request Approval",
    description: "Ask the daemon to create a scoped approval request.",
    capability: "approval.request",
    destructive: false,
    inputSchema: Object.freeze({
      type: "object",
      properties: {
        attemptId: IDENTIFIER_SCHEMA,
        requestedAt: { type: "string", format: "date-time" },
        dueAt: { type: ["string", "null"], format: "date-time" },
        priority: { type: "integer", minimum: 0, maximum: 3 }
      },
      required: ["attemptId", "requestedAt"],
      additionalProperties: false
    }),
    openWorld: false
  }),
  sideEffectTool({
    name: "vocation_update_pipeline",
    title: "Update Pipeline",
    description: "Request a daemon-authorized application pipeline transition.",
    capability: "pipeline.update",
    destructive: false,
    inputSchema: Object.freeze({
      type: "object",
      properties: {
        action: { enum: ["create", "approve", "block", "confirm"] },
        attemptId: IDENTIFIER_SCHEMA,
        expectedVersion: VERSION_SCHEMA,
        input: OPEN_OBJECT_SCHEMA,
        approval: OPEN_OBJECT_SCHEMA,
        blocker: { type: "string", minLength: 1, maxLength: 2000 },
        proof: OPEN_OBJECT_SCHEMA
      },
      required: ["action"],
      additionalProperties: false
    }),
    openWorld: false
  }),
  sideEffectTool({
    name: "vocation_request_submission",
    title: "Request Submission",
    description: "Request an approval-bound daemon submission. The MCP server never submits directly.",
    capability: "submission.request",
    destructive: true,
    inputSchema: Object.freeze({
      type: "object",
      properties: {
        attemptId: IDENTIFIER_SCHEMA,
        expectedVersion: VERSION_SCHEMA
      },
      required: ["attemptId", "expectedVersion"],
      additionalProperties: false
    }),
    openWorld: true
  }),
  sideEffectTool({
    name: "vocation_update_credentials",
    title: "Update Credentials",
    description: "Import a credential artifact or record an approved credential mapping through daemon authority.",
    capability: "credentials.update",
    destructive: true,
    inputSchema: Object.freeze({
      type: "object",
      properties: {
        action: { enum: ["import-passport", "record-mapping"] },
        value: OPEN_OBJECT_SCHEMA,
        sourcePath: { type: "string", minLength: 1, maxLength: 4096 },
        format: { enum: ["json", "json-ld", "compact-jws", "baked-png", "baked-svg"] },
        expectedSubjectId: { type: ["string", "null"], minLength: 1, maxLength: 512 },
        importedAt: { type: "string", format: "date-time" },
        expectedVersion: VERSION_SCHEMA
      },
      required: ["action", "expectedVersion"],
      additionalProperties: false
    }),
    openWorld: false
  })
] satisfies readonly McpToolDefinition[]);

export interface McpCatalogOptions {
  enableSideEffects?: boolean;
}

export function createMcpToolCatalog(options: McpCatalogOptions = {}): readonly McpToolDefinition[] {
  return options.enableSideEffects
    ? Object.freeze([...READ_ONLY_TOOLS, ...SIDE_EFFECT_TOOLS])
    : READ_ONLY_TOOLS;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP arguments must contain only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function createMcpArgumentDigest(argumentsValue: JsonObject): string {
  return createHash("sha256").update(canonicalJson(argumentsValue), "utf8").digest("hex");
}

export interface McpScopedApproval {
  approvalId: string;
  toolName: string;
  capability: string;
  argumentDigest: string;
  expiresAt: string;
}

export interface McpInvocationContext {
  capabilities?: readonly string[];
  approval?: McpScopedApproval;
  now?: Date;
}

export interface McpBackendRequest {
  tool: McpToolDefinition;
  arguments: JsonObject;
  authorization: {
    capability: string;
    approvalId: string;
  } | null;
}

export interface McpBackend {
  invoke(request: McpBackendRequest): Promise<unknown>;
}

export type McpPolicyErrorCode =
  | "unknown-tool"
  | "side-effects-disabled"
  | "capability-required"
  | "approval-required"
  | "approval-invalid";

export class McpPolicyError extends Error {
  public constructor(public readonly code: McpPolicyErrorCode, message: string) {
    super(message);
    this.name = "McpPolicyError";
  }
}

export interface McpExecutorOptions extends McpCatalogOptions {
  backend: McpBackend;
}

export class McpToolExecutor {
  private readonly enableSideEffects: boolean;

  public constructor(private readonly options: McpExecutorOptions) {
    this.enableSideEffects = options.enableSideEffects ?? false;
  }

  public listTools(): readonly McpToolDefinition[] {
    return createMcpToolCatalog({ enableSideEffects: this.enableSideEffects });
  }

  public async invoke(
    toolName: string,
    argumentsValue: JsonObject,
    context: McpInvocationContext = {}
  ): Promise<unknown> {
    const tool = [...READ_ONLY_TOOLS, ...SIDE_EFFECT_TOOLS].find((candidate) => candidate.name === toolName);
    if (!tool) throw new McpPolicyError("unknown-tool", `Unknown MCP tool: ${toolName}`);
    if (tool.security.effect === "read") {
      return this.options.backend.invoke({ tool, arguments: argumentsValue, authorization: null });
    }
    if (!this.enableSideEffects) {
      throw new McpPolicyError("side-effects-disabled", `MCP side effects are disabled: ${toolName}`);
    }

    const capability = tool.security.requiredCapability;
    if (!capability || !context.capabilities?.includes(capability)) {
      throw new McpPolicyError("capability-required", `MCP capability is required: ${capability ?? "unknown"}`);
    }
    const approval = context.approval;
    if (!approval) throw new McpPolicyError("approval-required", `Scoped approval is required: ${toolName}`);
    const expiresAt = Date.parse(approval.expiresAt);
    const now = (context.now ?? new Date()).getTime();
    if (
      approval.approvalId.trim().length === 0
      || approval.approvalId.trim() !== approval.approvalId
      || /[\r\n]/u.test(approval.approvalId)
      || approval.toolName !== toolName
      || approval.capability !== capability
      || approval.argumentDigest !== createMcpArgumentDigest(argumentsValue)
      || !Number.isFinite(expiresAt)
      || new Date(expiresAt).toISOString() !== approval.expiresAt
      || !Number.isFinite(now)
      || expiresAt <= now
    ) {
      throw new McpPolicyError("approval-invalid", `Scoped approval is not valid for ${toolName}`);
    }

    return this.options.backend.invoke({
      tool,
      arguments: argumentsValue,
      authorization: { capability, approvalId: approval.approvalId }
    });
  }
}
