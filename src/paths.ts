import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..");
export const SCHEMA_DIR = path.join(PACKAGE_ROOT, "schemas");
export const EXAMPLES_DIR = path.join(PACKAGE_ROOT, "examples");

export function defaultRuntimeRoot(): string {
  const configured = process.env["VOCATION_HOME"];
  return configured ? path.resolve(configured) : path.join(homedir(), ".vocationos");
}

export function defaultDatabasePath(): string {
  return path.join(defaultRuntimeRoot(), "vocation.db");
}

export function defaultArtifactVaultRoot(): string {
  return path.join(defaultRuntimeRoot(), "artifacts");
}

export function defaultDaemonLockPath(): string {
  return path.join(defaultRuntimeRoot(), "vocationd.lock.json");
}

export function defaultDaemonEndpoint(): string {
  if (process.platform === "win32") {
    const namespace = createHash("sha256")
      .update(defaultRuntimeRoot())
      .digest("hex")
      .slice(0, 24);
    return `\\\\.\\pipe\\vocation-os-${namespace}`;
  }
  return path.join(defaultRuntimeRoot(), "vocationd.sock");
}
