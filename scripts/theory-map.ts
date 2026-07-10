#!/usr/bin/env tsx
// Regenerates docs/THEORY_MAP.md from the code registry so the document can never drift from the source.
// Usage: npm run docs:theory-map
import { writeFileSync } from "node:fs";
import path from "node:path";
import { THEORY_REGISTRY } from "../src/theory.js";

function formatCitation(citation: { authors: string; year: number; title: string; source: string; doi?: string }): string {
  const doiPart = citation.doi ? ` https://doi.org/${citation.doi}` : "";
  return `${citation.authors} (${citation.year}). ${citation.title}. ${citation.source}.${doiPart}`;
}

const header = `# Theory Map

This document is generated from \`src/theory.ts\` by \`npm run docs:theory-map\`. Do not edit it by hand.

Each theory in VocationOS is an operational lens, not a label. A lens carries core constructs, decision questions asked at runtime, the modes it binds to, the rubric dimensions it informs, and primary source citations. Registry integrity is enforced by \`validateTheoryRegistry\` and the unit test suite. DOI resolution is verified against the Crossref registry with \`npm run citations:check\`, which is network dependent and therefore runs before releases rather than inside the offline ci chain.

The Ethical Risk Formulation entry is an engineering formulation aligned to risk management practice, not a vocational psychology theory, and is labeled as such in the registry.

## Registry

`;

const rows = THEORY_REGISTRY.map((lens) => {
  const citations = lens.citations.map(formatCitation).join("<br>");
  return `| ${lens.name} | ${lens.family} | ${lens.coreConstructs.join(", ")} | ${lens.modeBindings.join(", ")} | ${lens.rubricBindings.join(", ")} | ${citations} |`;
});

const table = [
  "| Theory | Family | Core constructs | Mode bindings | Rubric dimensions | Primary sources |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows
].join("\n");

const footer = `

## Reference list

${THEORY_REGISTRY.flatMap((lens) => lens.citations.map(formatCitation))
  .filter((value, index, all) => all.indexOf(value) === index)
  .sort()
  .map((entry) => `- ${entry}`)
  .join("\n")}
`;

const outputPath = path.join(process.cwd(), "docs", "THEORY_MAP.md");
writeFileSync(outputPath, `${header}${table}${footer}`, "utf8");
console.log(`wrote ${outputPath} with ${THEORY_REGISTRY.length} theory lenses`);
