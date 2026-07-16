import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { AuthorityOperation, VocationTransport, VocationTransportRequest } from "@vocation-os/sdk";
import { assertJsonValue, requireJsonObject, requireString } from "./validation.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MUTATING_OPERATIONS = new Set<AuthorityOperation>([
  "daemon-stop",
  "auto-apply-kill",
  "auto-apply-rearm",
  "auto-apply-enable",
  "auto-apply-evaluate",
  "legacy-import-apply",
  "checkpoint-create",
  "approver-register",
  "approver-revoke",
  "collector-register",
  "collector-revoke",
  "source-observation-record",
  "opportunity-truth-record",
  "liveness-assessment-record",
  "dedupe-result-record",
  "taxonomy-snapshot-record",
  "taxonomy-mapping-record",
  "assurance-case-record",
  "credential-passport-record",
  "credential-mapping-record",
  "campaign-record",
  "campaign-archive",
  "outcome-record",
  "outcome-archive",
  "domain-put",
  "domain-archive",
  "artifact-import",
  "onboarding-start",
  "onboarding-complete-step",
  "onboarding-fail",
  "onboarding-cancel",
  "onboarding-resume",
  "profile-import-plan",
  "profile-import-apply",
  "tracker-create",
  "tracker-approve",
  "tracker-submit",
  "tracker-block",
  "tracker-confirm"
]);

export interface VocationCliReadTransportOptions {
  cliPath?: string;
  maxOutputBytes?: number;
}

interface CommandSpec {
  executable: string;
  arguments: string[];
}

function assertFile(filePath: string, label: string): string {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`${label} is not a file: ${absolute}`);
  }
  return absolute;
}

export function bundledVocationCliPath(): string {
  return assertFile(
    fileURLToPath(new URL("../../../dist/cli.js", import.meta.url)),
    "Bundled VocationOS CLI"
  );
}

function commandSpec(cliPath: string, argumentsValue: readonly string[]): CommandSpec {
  const extension = path.extname(cliPath).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { executable: process.execPath, arguments: [cliPath, ...argumentsValue] };
  }
  return { executable: cliPath, arguments: [...argumentsValue] };
}

function domainListArguments(payloadValue: unknown): string[] {
  const payload = requireJsonObject(payloadValue, "Domain list payload");
  const domain = requireString(payload["domain"], "Product domain", { maxLength: 64 });
  const includeArchived = payload["includeArchived"];
  if (includeArchived !== undefined && typeof includeArchived !== "boolean") {
    throw new Error("Domain list includeArchived must be boolean");
  }
  return ["domain-list", domain, ...(includeArchived === true ? ["--all"] : [])];
}

export function vocationCliReadCommand(request: VocationTransportRequest): string[] {
  if (MUTATING_OPERATIONS.has(request.operation)) {
    throw new Error(`Read-only CLI transport rejects mutation: ${request.operation}`);
  }
  switch (request.operation) {
    case "health":
      return ["daemon-status"];
    case "domain-list":
      return domainListArguments(request.payload);
    case "tracker-list":
      return ["tracker-list"];
    case "artifact-list":
      return ["artifact-list"];
    case "approver-list":
      return ["approver-list"];
    case "collector-list":
      return ["collector-list"];
    case "audit-export":
      return ["export-audit"];
    case "credential-passport-list":
      return ["credential", "list"];
    case "auto-apply-status":
      return ["auto-apply-status"];
    case "onboarding-status":
      return ["onboarding-status"];
    default:
      throw new Error(`Read-only CLI transport does not expose operation: ${request.operation}`);
  }
}

function parseCliJson(stdout: string, operation: AuthorityOperation, maxOutputBytes: number): unknown {
  if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
    throw new Error(`Vocation CLI response exceeded the output limit for ${operation}`);
  }
  const serialized = stdout.trim();
  if (serialized.length === 0) throw new Error(`Vocation CLI returned no JSON for ${operation}`);
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(`Vocation CLI returned invalid JSON for ${operation}`, { cause: error });
  }
  assertJsonValue(value, "Vocation CLI response");
  return value;
}

export class VocationCliReadTransport implements VocationTransport {
  private readonly cliPath: string;
  private readonly maxOutputBytes: number;

  public constructor(options: VocationCliReadTransportOptions = {}) {
    this.cliPath = options.cliPath
      ? assertFile(options.cliPath, "VocationOS CLI")
      : bundledVocationCliPath();
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (
      !Number.isSafeInteger(this.maxOutputBytes)
      || this.maxOutputBytes < 1_024
      || this.maxOutputBytes > 8 * 1024 * 1024
    ) {
      throw new TypeError("CLI output limit must be between 1024 and 8388608 bytes");
    }
  }

  public async execute(request: VocationTransportRequest): Promise<unknown> {
    const command = commandSpec(this.cliPath, vocationCliReadCommand(request));
    const timeout = request.timeoutMs ?? 10_000;
    try {
      const result = await execFileAsync(command.executable, command.arguments, {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: this.maxOutputBytes,
        timeout,
        windowsHide: true
      });
      return parseCliJson(result.stdout, request.operation, this.maxOutputBytes);
    } catch (error) {
      throw new Error(`Vocation CLI request failed for ${request.operation}`, { cause: error });
    }
  }
}

export async function loadVocationTransportModule(modulePath: string): Promise<VocationTransport> {
  const absolute = assertFile(modulePath, "SDK transport module");
  const imported = await import(pathToFileURL(absolute).href) as Record<string, unknown>;
  const factory = imported["createVocationTransport"];
  if (typeof factory !== "function") {
    throw new Error("SDK transport module must export createVocationTransport()");
  }
  const transport = await factory() as unknown;
  if (
    typeof transport !== "object"
    || transport === null
    || typeof (transport as { execute?: unknown }).execute !== "function"
  ) {
    throw new Error("SDK transport module returned an invalid VocationTransport");
  }
  return transport as VocationTransport;
}
