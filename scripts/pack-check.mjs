#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const packOutput = execSync("npm pack --dry-run --json", {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const parsed = JSON.parse(packOutput);
const files = new Set(parsed[0].files.map((entry) => entry.path));
const failures = [];

if (!files.has("dist/cli.js")) {
  failures.push("dist/cli.js is missing from package");
}

for (const file of files) {
  if (file.startsWith("dist/test/")) {
    failures.push(`test build leaked into package: ${file}`);
  }
  if (file.startsWith("dist/src/")) {
    failures.push(`nested src build leaked into package: ${file}`);
  }
  if (file.startsWith("node_modules/") || file.startsWith(".vocationos/")) {
    failures.push(`runtime or dependency artifact leaked into package: ${file}`);
  }
}

const tempCwd = mkdtempSync(path.join(tmpdir(), "vocation-pack-check-"));
try {
  execFileSync("node", [path.join(root, "dist", "cli.js"), "help"], {
    cwd: tempCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  execFileSync("node", [path.join(root, "dist", "cli.js"), "doctor"], {
    cwd: tempCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
} catch (error) {
  failures.push(`dist cli failed from temp cwd: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(tempCwd, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("pack check passed");
