import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultAutoApplyConfig } from "./auto-apply.js";
import { defaultRuntimeRoot } from "./paths.js";
import { assertSchema } from "./schema.js";
import type { AutoApplyConfig } from "./types.js";

export function defaultAutoApplyConfigPath(): string {
  const configured = process.env["VOCATION_AUTO_APPLY_CONFIG"];
  return configured ? path.resolve(configured) : path.join(defaultRuntimeRoot(), "auto-apply-config.json");
}

export function loadAutoApplyConfig(filePath = defaultAutoApplyConfigPath()): AutoApplyConfig {
  if (!existsSync(filePath)) {
    return defaultAutoApplyConfig();
  }
  const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  assertSchema("auto-apply-config", value);
  return value as AutoApplyConfig;
}

export function saveAutoApplyConfig(config: AutoApplyConfig, filePath = defaultAutoApplyConfigPath()): void {
  assertSchema("auto-apply-config", config);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, filePath);
}
