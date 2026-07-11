#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is unavailable. Run this check through npm run sbom:check.");
}
const output = execFileSync(process.execPath, [npmExecPath, "sbom", "--sbom-format", "cyclonedx", "--package-lock-only"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const sbom = JSON.parse(output);
const failures = [];

if (sbom.bomFormat !== "CycloneDX") {
  failures.push("SBOM format is not CycloneDX");
}
if (typeof sbom.specVersion !== "string") {
  failures.push("SBOM specVersion is missing");
}
if (sbom.metadata?.component?.version !== packageJson.version) {
  failures.push(`SBOM package version mismatch: expected ${packageJson.version}`);
}
if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
  failures.push("SBOM contains no dependency components");
}
if (!Array.isArray(sbom.dependencies) || sbom.dependencies.length === 0) {
  failures.push("SBOM contains no dependency graph");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`sbom check passed: ${sbom.components.length} components`);

