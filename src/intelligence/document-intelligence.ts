import type { ClaimGraph } from "../types.js";
import { validateDocumentAstV2, type DocumentAstV2 } from "../documents/document-ast-v2.js";
import { sha256, stableStringify } from "../hash.js";

export interface DocumentVariant {
  variantId: string;
  document: DocumentAstV2;
  templateVersion: string;
  rendererVersion: string;
  sourceDocumentHash: string;
}

export interface AtsValidationInput {
  variant: DocumentVariant;
  graph: ClaimGraph;
  parseBackText: string;
  renderedPageCount: number;
  overflowDetected: boolean;
  visibleTextPixelRatio: number;
  targetKeywords: string[];
}

export interface AtsValidation {
  variantId: string;
  valid: boolean;
  reasons: string[];
  traceCoverage: number;
  parseBackCoverage: number;
  keywordCoverage: number;
  renderedPageCount: number;
  evidencePointers: string[];
  validationHash: string;
}

function words(value: string): string[] {
  return (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}+.#-]+/gu) ?? [])
    .map((token) => token.replace(/^[+.#-]+|[.-]+$/gu, ""))
    .filter(Boolean);
}

function boundedRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return Number(Math.min(1, numerator / denominator).toFixed(4));
}

export function validateAtsDocument(input: AtsValidationInput, now = new Date()): AtsValidation {
  const reasons: string[] = [];
  const documentValidation = validateDocumentAstV2(input.variant.document, input.graph, now);
  reasons.push(...documentValidation.reasons);
  if (!input.variant.templateVersion.trim() || !input.variant.rendererVersion.trim()) {
    reasons.push("document-render-version-missing");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.variant.sourceDocumentHash)) reasons.push("document-source-hash-invalid");
  if (input.renderedPageCount < 1 || !Number.isSafeInteger(input.renderedPageCount)) reasons.push("document-page-count-invalid");
  if (input.overflowDetected) reasons.push("document-layout-overflow");
  if (!Number.isFinite(input.visibleTextPixelRatio) || input.visibleTextPixelRatio < 0.002 || input.visibleTextPixelRatio > 0.75) {
    reasons.push("document-visible-text-ratio-invalid");
  }
  const expectedText = input.variant.document.sections
    .flatMap((section) => section.nodes)
    .filter((node) => node.type !== "heading")
    .map((node) => node.text)
    .join(" ");
  const expectedWords = words(expectedText);
  const parsedWordSet = new Set(words(input.parseBackText));
  const parseBackCoverage = boundedRatio(expectedWords.filter((word) => parsedWordSet.has(word)).length, expectedWords.length);
  if (parseBackCoverage < 0.98) reasons.push("document-parse-back-coverage-low");
  const normalizedKeywords = [...new Set(input.targetKeywords.flatMap(words))];
  const documentWordSet = new Set(expectedWords);
  const keywordCoverage = boundedRatio(normalizedKeywords.filter((word) => documentWordSet.has(word)).length, normalizedKeywords.length);
  const frequency = new Map<string, number>();
  for (const word of expectedWords) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  if ([...frequency.values()].some((count) => expectedWords.length >= 20 && count / expectedWords.length > 0.12)) {
    reasons.push("document-keyword-stuffing-suspected");
  }
  const observationBindingHash = sha256(stableStringify({
    sourceDocumentHash: input.variant.sourceDocumentHash,
    parseBackTextHash: sha256(input.parseBackText),
    renderedPageCount: input.renderedPageCount,
    overflowDetected: input.overflowDetected,
    visibleTextPixelRatio: input.visibleTextPixelRatio,
    targetKeywordHash: sha256(stableStringify(normalizedKeywords))
  }));
  const evidencePointers = [input.variant.sourceDocumentHash, observationBindingHash];
  const body = {
    variantId: input.variant.variantId,
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    traceCoverage: documentValidation.traceCoverage,
    parseBackCoverage,
    keywordCoverage,
    renderedPageCount: input.renderedPageCount,
    evidencePointers
  };
  return { ...body, validationHash: sha256(stableStringify(body)) };
}

export function humanEditDistance(original: string, edited: string): number {
  const left = words(original);
  const right = words(edited);
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      const deletion = previous[rightIndex]! + 1;
      const insertion = current[rightIndex - 1]! + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}
