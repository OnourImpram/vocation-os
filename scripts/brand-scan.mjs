#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizePath, walkFiles } from "./file-walk.mjs";

const forbidden = [
  [99, 97, 114, 101, 101, 114, 45, 97, 103, 101, 110, 116],
  [67, 97, 114, 101, 101, 114, 32, 65, 103, 101, 110, 116],
  [99, 97, 114, 101, 101, 114, 32, 97, 103, 101, 110, 116],
  [67, 65, 82, 69, 69, 82, 95, 65, 71, 69, 78, 84]
].map((codes) => String.fromCharCode(...codes));

const failures = [];

for (const filePath of walkFiles()) {
  const normalized = normalizePath(path.relative(process.cwd(), filePath));
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }
  for (const token of forbidden) {
    if (content.includes(token)) {
      failures.push(`${normalized}: forbidden legacy brand token`);
      break;
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("brand scan passed");
