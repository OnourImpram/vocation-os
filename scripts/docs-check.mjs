#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const metrics = JSON.parse(execFileSync("node", ["scripts/repo-metrics.mjs"], { cwd: process.cwd(), encoding: "utf8" }));
const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
const alphaGuidePath = path.join(process.cwd(), "docs", "VOCATIONOS_0.7_ALPHA.md");
const alphaGuide = existsSync(alphaGuidePath) ? readFileSync(alphaGuidePath, "utf8") : "";
const metricDocumentation = alphaGuide || readme;

const expectedLines = [
  ["Modes", metrics.modes],
  ["Theories", metrics.theories],
  ["Rubric dimensions", metrics.rubricDimensions],
  ["Schemas", metrics.schemas],
  ["CLI commands", metrics.cliCommands],
  ["Evaluator tests", metrics.evaluatorTests]
];

const failures = [];
for (const [label, count] of expectedLines) {
  const pattern = new RegExp(`\\| ${label} \\| ${count} \\|`);
  if (!pattern.test(metricDocumentation)) {
    const source = alphaGuide ? "alpha guide" : "README";
    failures.push(`${source} metric mismatch: ${label} expected ${count}`);
  }
}

if (/\bTODO\b|\bFIXME\b/.test(`${readme}\n${alphaGuide}`)) {
  failures.push("documentation contains TODO or FIXME");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`docs check passed using ${alphaGuide ? "the VocationOS 0.7 alpha guide" : "README"}`);
