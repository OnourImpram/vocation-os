#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function countArrayExport(filePath, exportName) {
  const content = readFileSync(filePath, "utf8");
  const match = content.match(new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\] as const`));
  if (!match) {
    throw new Error(`Could not find ${exportName}`);
  }
  return [...match[1].matchAll(/"[^"]+"/g)].length;
}

const root = process.cwd();
const metrics = {
  modes: countArrayExport(path.join(root, "src", "types.ts"), "MODE_NAMES"),
  theories: countArrayExport(path.join(root, "src", "theory.ts"), "THEORY_NAMES"),
  rubricDimensions: countArrayExport(path.join(root, "src", "rubric.ts"), "DIMENSION_IDS"),
  schemas: readdirSync(path.join(root, "schemas")).filter((file) => file.endsWith(".schema.json")).length,
  cliCommands: countArrayExport(path.join(root, "src", "types.ts"), "CLI_COMMANDS"),
  evaluatorTests: [...readFileSync(path.join(root, "src", "evaluator.ts"), "utf8").matchAll(/id: "EV-/g)].length
};

console.log(JSON.stringify(metrics, null, 2));
