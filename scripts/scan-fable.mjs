#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizePath, walkFiles } from "./file-walk.mjs";

const needle = String.fromCharCode(102, 97, 98, 108, 101);
const failures = [];

for (const filePath of walkFiles()) {
  const normalized = normalizePath(path.relative(process.cwd(), filePath));
  if (normalized === "scripts/scan-fable.mjs" || normalized === "package.json" || normalized === "package-lock.json") {
    continue;
  }
  try {
    const content = readFileSync(filePath, "utf8").toLowerCase();
    if (content.includes(needle)) {
      failures.push(`${normalized}: disallowed narrative marker`);
    }
  } catch {
    continue;
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("scan passed");
