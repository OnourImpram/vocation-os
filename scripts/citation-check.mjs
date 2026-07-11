#!/usr/bin/env node
// Deterministic citation contract check. It never performs network requests.
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(process.cwd(), "src", "theory.ts"), "utf8");
const references = [...source.matchAll(
  /year:\s*(\d{4}),\s*\r?\n\s*title:\s*"([^"]+)",\s*\r?\n\s*source:\s*"([^"]+)",\s*\r?\n\s*doi:\s*"([^"]+)"/g
)].map((match) => ({
  year: Number(match[1]),
  title: match[2],
  source: match[3],
  doi: match[4]
}));

if (references.length === 0) {
  console.error("No complete citation records found in src/theory.ts");
  process.exit(1);
}

const failures = [];
const seen = new Set();
const doiPattern = /^10\.\d{4,9}\/[A-Za-z0-9][A-Za-z0-9._;()/:-]+$/;
for (const reference of references) {
  if (!Number.isInteger(reference.year) || reference.year < 1900 || reference.year > new Date().getUTCFullYear()) {
    failures.push(`${reference.doi}: invalid publication year`);
  }
  if (!reference.title || !reference.source) failures.push(`${reference.doi}: title and source are required`);
  if (!doiPattern.test(reference.doi)) failures.push(`${reference.doi}: invalid DOI format`);
  const normalizedDoi = reference.doi.toLowerCase();
  if (seen.has(normalizedDoi)) failures.push(`${reference.doi}: duplicate DOI`);
  seen.add(normalizedDoi);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`citation contract check passed for ${references.length} records`);
