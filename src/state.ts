import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultRuntimeRoot } from "./paths.js";
import { assertSchema, validateAgainstSchema, type SchemaName } from "./schema.js";

export function encodeStateKey(key: string): string {
  if (key.length === 0) {
    throw new Error("State key cannot be empty");
  }
  return Buffer.from(key, "utf8").toString("base64url");
}

export function decodeStateKey(encoded: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("State filename is not canonical Base64URL");
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (decoded.length === 0 || encodeStateKey(decoded) !== encoded) {
    throw new Error("State filename is not a canonical encoded state key");
  }
  return decoded;
}

export function statePathForKey(baseDir: string, key: string): string {
  return path.join(baseDir, `${encodeStateKey(key)}.json`);
}

export function inferSchemaName(key: string, value: unknown): SchemaName | null {
  if (key.startsWith("auto-apply:config")) {
    return "auto-apply-config";
  }
  if (key.startsWith("claim-graph")) {
    return "claim-graph";
  }
  if (key.startsWith("application-packet")) {
    return "application-packet";
  }
  if (key.startsWith("action-ledger-entry")) {
    return "action-ledger-entry";
  }
  if (key.startsWith("mode-output")) {
    return "mode-output";
  }
  if (key.startsWith("opportunity-score")) {
    return "opportunity-score";
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if ("claims" in record && "validationSummary" in record) {
      return "claim-graph";
    }
    if ("packetHash" in record && "approvalRequired" in record) {
      return "application-packet";
    }
    if ("killSwitch" in record && "adapterAllowlist" in record) {
      return "auto-apply-config";
    }
    if ("mode" in record && "highStakesCertaintyGate" in record) {
      return "mode-output";
    }
    if ("compositeScore" in record && "dimensions" in record) {
      return "opportunity-score";
    }
  }

  return null;
}

export function writeState(baseDir: string, key: string, value: unknown): string {
  const schemaName = inferSchemaName(key, value);
  if (schemaName) {
    assertSchema(schemaName, value);
  }

  mkdirSync(baseDir, { recursive: true });
  const finalPath = statePathForKey(baseDir, key);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, finalPath);
  return finalPath;
}

export function readState<T>(baseDir: string, key: string): T {
  const filePath = statePathForKey(baseDir, key);
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function defaultStateDir(): string {
  return path.join(defaultRuntimeRoot(), "_state");
}

export function stateExists(baseDir: string, key: string): boolean {
  return existsSync(statePathForKey(baseDir, key));
}

export interface StateValidationFileResult {
  file: string;
  key?: string;
  schemaName?: SchemaName | null;
  valid: boolean;
  warning?: string;
  errors?: string[];
}

export interface StateValidationReport {
  valid: boolean;
  checked: number;
  message?: string;
  results: StateValidationFileResult[];
}

export function validateStateDirectory(baseDir: string): StateValidationReport {
  if (!existsSync(baseDir)) {
    return { valid: true, checked: 0, message: "state directory does not exist", results: [] };
  }
  const files = readdirSync(baseDir).filter((file) => file.endsWith(".json"));
  const results: StateValidationFileResult[] = files.map((file) => {
    const filePath = path.join(baseDir, file);
    try {
      const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      const key = decodeStateKey(file.replace(/\.json$/, ""));
      const schemaName = inferSchemaName(key, value);
      if (!schemaName) {
        return { file, key, schemaName: null, valid: true, warning: "schema not inferred" };
      }
      const validation = validateAgainstSchema(schemaName, value);
      return { file, key, schemaName, valid: validation.valid, errors: validation.errors };
    } catch (error) {
      return { file, valid: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  });
  return {
    valid: results.every((result) => result.valid),
    checked: files.length,
    results
  };
}
