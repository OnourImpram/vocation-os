#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizePath, walkFiles } from "./file-walk.mjs";

const productionRoots = ["src/", "packages/"];
const allowedFiles = new Set([
  "src/discovery/governed-fetch-broker.ts",
  "packages/workbench/src/index.ts"
]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const forbiddenPatterns = [
  { label: "global fetch", pattern: /\bfetch\s*\(/g },
  { label: "global fetch reference", pattern: /\bglobalThis\s*\.\s*fetch\b/g },
  { label: "injected fetch alias", pattern: /\bfetchImpl\b/g },
  { label: "global fetch type", pattern: /\btypeof\s+fetch\b/g },
  { label: "global fetch fallback", pattern: /\?\?\s*fetch\b/g },
  { label: "node http request", pattern: /\bhttp\s*\.\s*(?:get|request)\s*\(/g },
  { label: "node https request", pattern: /\bhttps\s*\.\s*(?:get|request)\s*\(/g },
  { label: "undici request", pattern: /\bundici\s*\.\s*(?:fetch|request)\s*\(/g },
  { label: "axios request", pattern: /\baxios\s*(?:\.|\()/g },
  { label: "got request", pattern: /\bgot\s*\(/g }
];
const failures = [];

for (const filePath of walkFiles()) {
  const relativePath = normalizePath(path.relative(process.cwd(), filePath));
  if (!productionRoots.some((root) => relativePath.startsWith(root))) continue;
  if (!sourceExtensions.has(path.extname(relativePath))) continue;
  if (relativePath.includes("/dist/") || relativePath.includes("/test/")) continue;
  if (allowedFiles.has(relativePath)) continue;

  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const { label, pattern } of forbiddenPatterns) {
    for (const [index, line] of lines.entries()) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) failures.push(`${relativePath}:${index + 1}: ${label} bypasses GovernedFetchBroker`);
    }
  }
}

if (failures.length > 0) {
  console.error("Network boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Network boundary check passed. Production network access is confined to GovernedFetchBroker.");
