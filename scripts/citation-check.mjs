#!/usr/bin/env node
// Verifies every DOI declared in src/theory.ts against the Crossref registry.
// Network dependent by design, so it is not part of the offline ci chain.
// Run before any public release: npm run citations:check
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(process.cwd(), "src", "theory.ts"), "utf8");
const dois = [...source.matchAll(/doi: "([^"]+)"/g)].map((match) => match[1]);
const unique = [...new Set(dois)];

if (unique.length === 0) {
  console.error("No DOIs found in src/theory.ts");
  process.exit(1);
}

const failures = [];
let checked = 0;

for (const doi of unique) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "vocation-os-citation-check (mailto:maintainer@localhost)" }
    });
    if (!response.ok) {
      failures.push(`${doi}: HTTP ${response.status}`);
      continue;
    }
    const payload = await response.json();
    const title = payload?.message?.title?.[0];
    if (typeof title !== "string" || title.length === 0) {
      failures.push(`${doi}: no title in Crossref record`);
      continue;
    }
    checked += 1;
    console.log(`ok ${doi} :: ${title.slice(0, 80)}`);
  } catch (error) {
    failures.push(`${doi}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`checked ${checked} of ${unique.length} DOIs`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("citation check passed");
