import { createHash } from "node:crypto";
import path from "node:path";
import { VocationClient, type AuthorityOperation } from "@vocation-os/sdk";
import {
  createMcpArgumentDigest,
  type JsonObject,
  type McpBackend,
  type McpBackendRequest
} from "./index.js";
import {
  McpInputError,
  hasOnlyKeys,
  requireIsoTimestamp,
  requireJsonObject,
  requireNonNegativeInteger,
  requireString
} from "./validation.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface VocationSdkBackendOptions {
  timeoutMs?: number;
}

function assertExactArguments(argumentsValue: JsonObject, allowed: readonly string[]): void {
  if (!hasOnlyKeys(argumentsValue, allowed)) {
    throw new McpInputError("Tool arguments contain unsupported fields");
  }
}

function requestIdForMutation(request: McpBackendRequest, stage = "authority"): string {
  if (!request.authorization) throw new McpInputError("Mutation authorization is missing");
  const digest = createHash("sha256")
    .update(request.authorization.approvalId, "utf8")
    .update("\0", "utf8")
    .update(request.tool.name, "utf8")
    .update("\0", "utf8")
    .update(stage, "utf8")
    .update("\0", "utf8")
    .update(createMcpArgumentDigest(request.arguments), "utf8")
    .digest("hex");
  return `REQ-MCP-${digest.slice(0, 48)}`;
}

function mutationEnvelope(
  request: McpBackendRequest,
  authorityRequestId: string,
  data: unknown
): Record<string, unknown> {
  if (!request.authorization) throw new McpInputError("Mutation authorization is missing");
  return {
    authority: "vocationd",
    tool: request.tool.name,
    readOnly: false,
    authorityRequestId,
    authorization: {
      capability: request.authorization.capability,
      approvalId: request.authorization.approvalId
    },
    data
  };
}

function readEnvelope(tool: string, data: unknown): Record<string, unknown> {
  return { authority: "vocationd", tool, readOnly: true, data };
}

export class VocationSdkBackend implements McpBackend {
  private readonly timeoutMs: number;

  public constructor(
    private readonly client: VocationClient,
    options: VocationSdkBackendOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new TypeError("MCP daemon timeout must be between 100 and 120000 milliseconds");
    }
  }

  private request(
    operation: AuthorityOperation,
    payload: unknown = {},
    requestId?: string
  ): Promise<unknown> {
    return this.client.request(operation, payload, {
      timeoutMs: operation === "audit-export" ? Math.max(this.timeoutMs, 30_000) : this.timeoutMs,
      ...(requestId ? { requestId } : {})
    });
  }

  private async invokeRead(request: McpBackendRequest): Promise<unknown> {
    assertExactArguments(request.arguments, []);
    switch (request.tool.name) {
      case "vocation_health":
        return readEnvelope(request.tool.name, await this.request("health"));
      case "vocation_today": {
        const [health, opportunities, applications, tasks] = await Promise.all([
          this.request("health"),
          this.request("domain-list", { domain: "opportunities" }),
          this.request("tracker-list"),
          this.request("domain-list", { domain: "tasks" })
        ]);
        return readEnvelope(request.tool.name, { health, opportunities, applications, tasks });
      }
      case "vocation_discovery":
        return readEnvelope(
          request.tool.name,
          await this.request("domain-list", { domain: "opportunities" })
        );
      case "vocation_review": {
        const [opportunities, tasks] = await Promise.all([
          this.request("domain-list", { domain: "opportunities" }),
          this.request("domain-list", { domain: "tasks" })
        ]);
        return readEnvelope(request.tool.name, { opportunities, tasks });
      }
      case "vocation_twin":
        return readEnvelope(request.tool.name, await this.request("domain-list", { domain: "profiles" }));
      case "vocation_documents":
        return readEnvelope(request.tool.name, await this.request("domain-list", { domain: "documents" }));
      case "vocation_pipeline":
        return readEnvelope(request.tool.name, await this.request("tracker-list"));
      case "vocation_evidence":
        return readEnvelope(request.tool.name, await this.request("artifact-list"));
      case "vocation_approvals":
        return readEnvelope(request.tool.name, await this.request("approver-list"));
      case "vocation_audit":
        return readEnvelope(request.tool.name, await this.request("audit-export"));
      case "vocation_credentials":
        return readEnvelope(request.tool.name, await this.request("credential-passport-list"));
      case "vocation_interview":
      case "vocation_offers":
        return readEnvelope(request.tool.name, await this.request("domain-list", { domain: "outcomes" }));
      case "vocation_settings": {
        const [health, automation, onboarding] = await Promise.all([
          this.request("health"),
          this.request("auto-apply-status"),
          this.request("onboarding-status")
        ]);
        return readEnvelope(request.tool.name, { health, automation, onboarding });
      }
      default:
        throw new McpInputError(`No SDK read route is registered for ${request.tool.name}`);
    }
  }

  private async requestApproval(request: McpBackendRequest): Promise<unknown> {
    assertExactArguments(request.arguments, ["attemptId", "requestedAt", "dueAt", "priority"]);
    const attemptId = requireString(request.arguments["attemptId"], "Application attempt id", {
      maxLength: 128,
      pattern: IDENTIFIER_PATTERN
    });
    const requestedAt = requireIsoTimestamp(request.arguments["requestedAt"], "Requested at");
    const dueAtValue = request.arguments["dueAt"];
    const dueAt = dueAtValue === undefined || dueAtValue === null
      ? null
      : requireIsoTimestamp(dueAtValue, "Due at");
    if (dueAt !== null && Date.parse(dueAt) <= Date.parse(requestedAt)) {
      throw new McpInputError("Due at must be later than requested at");
    }
    const priorityValue = request.arguments["priority"];
    const priority = priorityValue === undefined ? 1 : requireNonNegativeInteger(priorityValue, "Priority");
    if (priority > 3) throw new McpInputError("Priority must be between zero and three");

    const argumentDigest = createMcpArgumentDigest(request.arguments).toUpperCase();
    const authorityRequestId = requestIdForMutation(request);
    const data = await this.request("domain-put", {
      domain: "tasks",
      expectedVersion: 0,
      value: {
        taskId: `TSK-APPROVAL-${argumentDigest.slice(0, 24)}`,
        title: "Review application approval",
        status: "pending",
        priority,
        relatedDomain: "applications",
        relatedRecordId: attemptId,
        dueAt,
        completedAt: null,
        createdAt: requestedAt,
        updatedAt: requestedAt
      }
    }, authorityRequestId);
    return mutationEnvelope(request, authorityRequestId, data);
  }

  private async updatePipeline(request: McpBackendRequest): Promise<unknown> {
    const action = requireString(request.arguments["action"], "Pipeline action", { maxLength: 16 });
    if (!["create", "approve", "block", "confirm"].includes(action)) {
      throw new McpInputError("Pipeline action must be create, approve, block, or confirm");
    }
    let operation: AuthorityOperation;
    let payload: JsonObject;
    if (action === "create") {
      assertExactArguments(request.arguments, ["action", "input"]);
      operation = "tracker-create";
      payload = { input: requireJsonObject(request.arguments["input"], "Tracker input") };
    } else {
      const attemptId = requireString(request.arguments["attemptId"], "Application attempt id", {
        maxLength: 128,
        pattern: IDENTIFIER_PATTERN
      });
      const expectedVersion = requireNonNegativeInteger(
        request.arguments["expectedVersion"],
        "Expected version"
      );
      if (action === "approve") {
        assertExactArguments(request.arguments, ["action", "attemptId", "expectedVersion", "approval"]);
        operation = "tracker-approve";
        payload = {
          attemptId,
          expectedVersion,
          approval: requireJsonObject(request.arguments["approval"], "Tracker approval")
        };
      } else if (action === "block") {
        assertExactArguments(request.arguments, ["action", "attemptId", "expectedVersion", "blocker"]);
        operation = "tracker-block";
        payload = {
          attemptId,
          expectedVersion,
          blocker: requireString(request.arguments["blocker"], "Application blocker", { maxLength: 2_000 })
        };
      } else if (action === "confirm") {
        assertExactArguments(request.arguments, ["action", "attemptId", "expectedVersion", "proof"]);
        operation = "tracker-confirm";
        payload = {
          attemptId,
          expectedVersion,
          proof: requireJsonObject(request.arguments["proof"], "Submission proof")
        };
      } else throw new McpInputError("Pipeline action is unsupported");
    }

    const authorityRequestId = requestIdForMutation(request);
    const data = await this.request(operation, payload, authorityRequestId);
    return mutationEnvelope(request, authorityRequestId, data);
  }

  private async requestSubmission(request: McpBackendRequest): Promise<unknown> {
    assertExactArguments(request.arguments, ["attemptId", "expectedVersion"]);
    const payload = {
      attemptId: requireString(request.arguments["attemptId"], "Application attempt id", {
        maxLength: 128,
        pattern: IDENTIFIER_PATTERN
      }),
      expectedVersion: requireNonNegativeInteger(request.arguments["expectedVersion"], "Expected version")
    };
    const authorityRequestId = requestIdForMutation(request);
    const data = await this.request("tracker-submit", payload, authorityRequestId);
    return mutationEnvelope(request, authorityRequestId, data);
  }

  private async updateCredentials(request: McpBackendRequest): Promise<unknown> {
    const action = requireString(request.arguments["action"], "Credential action", { maxLength: 32 });
    if (action === "record-mapping") {
      assertExactArguments(request.arguments, ["action", "value", "expectedVersion"]);
      const authorityRequestId = requestIdForMutation(request, "credential-mapping");
      const data = await this.request("credential-mapping-record", {
        value: requireJsonObject(request.arguments["value"], "Credential mapping"),
        expectedVersion: requireNonNegativeInteger(request.arguments["expectedVersion"], "Expected version")
      }, authorityRequestId);
      return mutationEnvelope(request, authorityRequestId, data);
    }
    if (action !== "import-passport") {
      throw new McpInputError("Credential action must be import-passport or record-mapping");
    }
    assertExactArguments(request.arguments, [
      "action",
      "expectedSubjectId",
      "expectedVersion",
      "format",
      "importedAt",
      "sourcePath"
    ]);
    const sourcePath = requireString(request.arguments["sourcePath"], "Credential source path", { maxLength: 4_096 });
    if (!path.isAbsolute(sourcePath)) throw new McpInputError("Credential source path must be absolute");
    const format = requireString(request.arguments["format"], "Credential format", { maxLength: 32 });
    if (!["json", "json-ld", "compact-jws", "baked-png", "baked-svg"].includes(format)) {
      throw new McpInputError("Credential format is unsupported");
    }
    const subjectValue = request.arguments["expectedSubjectId"];
    const expectedSubjectId = subjectValue === null
      ? null
      : requireString(subjectValue, "Expected credential subject id", { maxLength: 512 });
    const importedAt = requireIsoTimestamp(request.arguments["importedAt"], "Credential import time");
    const expectedVersion = requireNonNegativeInteger(request.arguments["expectedVersion"], "Expected version");
    const artifactRequestId = requestIdForMutation(request, "artifact-import");
    const manifest = await this.request("artifact-import", { sourcePath }, artifactRequestId);
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new McpInputError("Artifact import did not return a manifest");
    }
    const authorityRequestId = requestIdForMutation(request, "credential-import");
    const data = await this.request("credential-import-artifact", {
      manifest,
      format,
      expectedSubjectId,
      importedAt,
      expectedVersion
    }, authorityRequestId);
    return mutationEnvelope(request, authorityRequestId, { artifact: manifest, passport: data });
  }

  public invoke(request: McpBackendRequest): Promise<unknown> {
    if (request.tool.security.effect === "read") return this.invokeRead(request);
    switch (request.tool.name) {
      case "vocation_request_approval":
        return this.requestApproval(request);
      case "vocation_update_pipeline":
        return this.updatePipeline(request);
      case "vocation_request_submission":
        return this.requestSubmission(request);
      case "vocation_update_credentials":
        return this.updateCredentials(request);
      default:
        return Promise.reject(new McpInputError(`No SDK mutation route is registered for ${request.tool.name}`));
    }
  }
}
