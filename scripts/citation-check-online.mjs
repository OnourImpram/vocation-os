#!/usr/bin/env node
// Optional bounded Crossref verification. This is intentionally outside required CI.
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(process.cwd(), "src", "theory.ts"), "utf8");
const dois = [...new Set([...source.matchAll(/doi: "([^"]+)"/g)].map((match) => match[1]))];
if (dois.length === 0) throw new Error("No DOIs found in src/theory.ts");

const failures = [];
let cursor = 0;
const workerCount = Math.min(4, dois.length);

async function verifyNext() {
  while (cursor < dois.length) {
    const doi = dois[cursor++];
    try {
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
        headers: { "user-agent": "vocation-os-citation-check" },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) {
        failures.push(`${doi}: HTTP ${response.status}`);
        continue;
      }
      const payload = await response.json();
      const title = payload?.message?.title?.[0];
      if (typeof title !== "string" || title.length === 0) failures.push(`${doi}: no title in Crossref record`);
    } catch (error) {
      failures.push(`${doi}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await Promise.all(Array.from({ length: workerCount }, () => verifyNext()));
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`online citation check passed for ${dois.length} records`);
