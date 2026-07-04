#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizePath, walkFiles } from "./file-walk.mjs";

function trackedFiles() {
  try {
    const output = execFileSync("git", ["ls-files"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const files = output.split(/\r?\n/).filter(Boolean);
    return files.length > 0 ? files.map((file) => path.join(process.cwd(), file)) : walkFiles();
  } catch {
    return walkFiles();
  }
}

const riskyPathPatterns = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)upload\//i,
  /(^|\/)download\//i,
  /(^|\/)tool-results\//i,
  /(^|\/)_archive\//i,
  /(^|\/)_state\//i,
  /(^|\/)_research\/.*\.json$/i,
  /(^|\/)private-profile\//i,
  /\.(pdf|doc|docx|db|sqlite|sqlite3|key|pem|p12|crt)$/i
];

const secretPatterns = [
  /OPENAI_API_KEY\s*=/i,
  /ANTHROPIC_API_KEY\s*=/i,
  /GITHUB_TOKEN\s*=/i,
  /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{32,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/
];

const failures = [];

for (const filePath of trackedFiles()) {
  const normalized = normalizePath(path.relative(process.cwd(), filePath));
  if (riskyPathPatterns.some((pattern) => pattern.test(normalized))) {
    failures.push(`risky path: ${normalized}`);
    continue;
  }
  try {
    const content = readFileSync(filePath, "utf8");
    if (secretPatterns.some((pattern) => pattern.test(content))) {
      failures.push(`secret pattern: ${normalized}`);
    }
  } catch {
    continue;
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("privacy scan passed");
