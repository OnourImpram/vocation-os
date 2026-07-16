import { sha256, stableStringify } from "../hash.js";
import {
  taxonomySnapshotReference,
  validateTaxonomySnapshot,
  validateTaxonomySnapshotReference,
  type TaxonomyConcept,
  type TaxonomySnapshot,
  type TaxonomySnapshotReference
} from "./snapshot.js";

export const TAXONOMY_MAPPING_RELATIONS = ["exact", "close", "broad", "narrow", "related"] as const;
export const TAXONOMY_MAPPING_METHODS = ["official-crosswalk", "curated", "deterministic-label"] as const;

export type TaxonomyMappingRelation = (typeof TAXONOMY_MAPPING_RELATIONS)[number];
export type TaxonomyMappingMethod = (typeof TAXONOMY_MAPPING_METHODS)[number];

export interface TaxonomyMappingEvidence {
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly note: string;
}

export interface TaxonomyCrosswalkEntry {
  readonly fromConceptId: string;
  readonly toConceptId: string;
  readonly relation: TaxonomyMappingRelation;
  readonly confidence: number;
  readonly method: TaxonomyMappingMethod;
  readonly evidence: readonly TaxonomyMappingEvidence[];
}

export interface TaxonomyMappingRecord extends TaxonomyCrosswalkEntry {
  readonly mappingId: string;
}

export interface TaxonomyMappingSet {
  readonly mappingSetId: string;
  readonly mappingVersion: string;
  readonly createdAt: string;
  readonly fromSnapshot: TaxonomySnapshotReference;
  readonly toSnapshot: TaxonomySnapshotReference;
  readonly mappings: readonly TaxonomyMappingRecord[];
  readonly contentHash: string;
}

export type TaxonomyMappingSetValidationResult =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly string[] };

export interface TaxonomyConceptMatch {
  readonly conceptId: string;
  readonly score: number;
  readonly matchedLabel: string;
  readonly method: "deterministic-label-v1";
  readonly provenance: TaxonomySnapshotReference;
}

export interface TaxonomyMappingProposal {
  readonly fromConceptId: string;
  readonly toConceptId: string;
  readonly relation: "close";
  readonly confidence: number;
  readonly method: "deterministic-label";
  readonly matchedLabels: readonly [string, string];
  readonly provenance: {
    readonly fromSnapshot: TaxonomySnapshotReference;
    readonly toSnapshot: TaxonomySnapshotReference;
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO date-time`);
  }
  return value;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function labelTokens(value: string): Set<string> {
  return new Set(normalizeLabel(value).split(" ").filter((token) => token.length > 1));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / union.size;
}

function bestLabelMatch(query: string, concept: TaxonomyConcept): { score: number; label: string } {
  const normalizedQuery = normalizeLabel(query);
  let best = { score: 0, label: concept.preferredLabel };
  for (const label of [concept.preferredLabel, ...concept.alternateLabels]) {
    const normalized = normalizeLabel(label);
    const score = normalized === normalizedQuery ? 1 : jaccard(labelTokens(normalizedQuery), labelTokens(normalized));
    if (score > best.score || (score === best.score && compareText(label, best.label) < 0)) best = { score, label };
  }
  return best;
}

function assertSnapshot(snapshot: TaxonomySnapshot): void {
  const validation = validateTaxonomySnapshot(snapshot);
  if (!validation.valid) throw new Error(`Invalid taxonomy snapshot: ${validation.errors.join("; ")}`);
}

function validateEvidence(evidence: readonly TaxonomyMappingEvidence[]): void {
  if (evidence.length === 0) throw new Error("Taxonomy mappings require provenance evidence");
  for (const item of evidence) {
    if (!isHttpsUrl(item.sourceUrl)) throw new Error("Taxonomy mapping evidence URL must use governed HTTPS");
    canonicalTimestamp(item.retrievedAt, "Taxonomy mapping evidence date");
    if (!item.note.trim() || item.note.length > 1_000 || /[\0]/.test(item.note)) throw new Error("Taxonomy mapping evidence note is invalid");
  }
}

function mappingId(
  entry: TaxonomyCrosswalkEntry,
  from: TaxonomySnapshotReference,
  to: TaxonomySnapshotReference
): string {
  const digest = sha256(stableStringify({
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    entry
  })).slice("sha256:".length, "sha256:".length + 24).toUpperCase();
  return `TMAP-${digest}`;
}

export function createTaxonomyMappingSet(input: {
  readonly mappingVersion: string;
  readonly createdAt: string;
  readonly fromSnapshot: TaxonomySnapshot;
  readonly toSnapshot: TaxonomySnapshot;
  readonly entries: readonly TaxonomyCrosswalkEntry[];
}): TaxonomyMappingSet {
  assertSnapshot(input.fromSnapshot);
  assertSnapshot(input.toSnapshot);
  if (input.fromSnapshot.source === input.toSnapshot.source) throw new Error("Cross-taxonomy mappings require different sources");
  if (new Set([input.fromSnapshot.source, input.toSnapshot.source]).size !== 2) {
    throw new Error("Cross-taxonomy mappings require ESCO and O*NET snapshots");
  }
  if (!input.mappingVersion.trim() || input.mappingVersion.length > 64) throw new Error("mappingVersion is invalid");
  const createdAt = canonicalTimestamp(input.createdAt, "createdAt");
  const fromReference = taxonomySnapshotReference(input.fromSnapshot);
  const toReference = taxonomySnapshotReference(input.toSnapshot);
  const fromIds = new Set(input.fromSnapshot.concepts.map((concept) => concept.conceptId));
  const toIds = new Set(input.toSnapshot.concepts.map((concept) => concept.conceptId));
  const pairIds = new Set<string>();
  const mappings = input.entries.map((entry): TaxonomyMappingRecord => {
    if (!fromIds.has(entry.fromConceptId)) throw new Error(`Unknown source taxonomy concept: ${entry.fromConceptId}`);
    if (!toIds.has(entry.toConceptId)) throw new Error(`Unknown target taxonomy concept: ${entry.toConceptId}`);
    if (!(TAXONOMY_MAPPING_RELATIONS as readonly string[]).includes(entry.relation)) throw new Error("Taxonomy mapping relation is invalid");
    if (!(TAXONOMY_MAPPING_METHODS as readonly string[]).includes(entry.method)) throw new Error("Taxonomy mapping method is invalid");
    if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
      throw new Error("Taxonomy mapping confidence must be between zero and one");
    }
    if (entry.method === "deterministic-label" && (entry.relation === "exact" || entry.confidence > 0.89)) {
      throw new Error("Deterministic label mapping cannot assert exact or high-confidence ontology equivalence");
    }
    validateEvidence(entry.evidence);
    const pairId = `${entry.fromConceptId}\0${entry.toConceptId}`;
    if (pairIds.has(pairId)) throw new Error(`Duplicate taxonomy mapping pair: ${entry.fromConceptId} to ${entry.toConceptId}`);
    pairIds.add(pairId);
    const canonicalEntry: TaxonomyCrosswalkEntry = {
      fromConceptId: entry.fromConceptId,
      toConceptId: entry.toConceptId,
      relation: entry.relation,
      confidence: entry.confidence,
      method: entry.method,
      evidence: Object.freeze(entry.evidence.map((item) => Object.freeze({
        sourceUrl: new URL(item.sourceUrl).toString(),
        retrievedAt: canonicalTimestamp(item.retrievedAt, "Taxonomy mapping evidence date"),
        note: item.note.trim().replace(/\s+/g, " ")
      })).sort((left, right) =>
        compareText(left.sourceUrl, right.sourceUrl) ||
        compareText(left.retrievedAt, right.retrievedAt) ||
        compareText(left.note, right.note)
      ))
    };
    return Object.freeze({
      mappingId: mappingId(canonicalEntry, fromReference, toReference),
      ...canonicalEntry
    });
  }).sort((left, right) =>
    compareText(left.fromConceptId, right.fromConceptId) || compareText(left.toConceptId, right.toConceptId)
  );
  const canonical = {
    mappingVersion: input.mappingVersion.trim(),
    createdAt,
    fromSnapshot: fromReference,
    toSnapshot: toReference,
    mappings: Object.freeze(mappings)
  };
  const contentHash = sha256(stableStringify(canonical));
  const setDigest = contentHash.slice("sha256:".length, "sha256:".length + 24).toUpperCase();
  const mappingSet = Object.freeze({
    mappingSetId: `TMSET-${setDigest}`,
    ...canonical,
    contentHash
  });
  const validation = validateTaxonomyMappingSet(mappingSet);
  if (!validation.valid) throw new Error(`TaxonomyMappingSet validation failed: ${validation.errors.join("; ")}`);
  return mappingSet;
}

export function validateTaxonomyMappingSet(
  mappingSet: TaxonomyMappingSet
): TaxonomyMappingSetValidationResult {
  const errors: string[] = [];
  if (!/^TMSET-[A-F0-9]{24}$/.test(mappingSet.mappingSetId)) errors.push("mappingSetId is invalid");
  if (!mappingSet.mappingVersion.trim() || mappingSet.mappingVersion.length > 64) errors.push("mappingVersion is invalid");
  try {
    canonicalTimestamp(mappingSet.createdAt, "createdAt");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "createdAt is invalid");
  }
  const fromValidation = validateTaxonomySnapshotReference(mappingSet.fromSnapshot);
  const toValidation = validateTaxonomySnapshotReference(mappingSet.toSnapshot);
  if (!fromValidation.valid) errors.push(...fromValidation.errors.map((error) => `fromSnapshot: ${error}`));
  if (!toValidation.valid) errors.push(...toValidation.errors.map((error) => `toSnapshot: ${error}`));
  if (mappingSet.fromSnapshot.source === mappingSet.toSnapshot.source) {
    errors.push("mapping snapshots must use different taxonomy sources");
  }
  const pairs = new Set<string>();
  for (const mapping of mappingSet.mappings) {
    const pair = `${mapping.fromConceptId}\0${mapping.toConceptId}`;
    if (pairs.has(pair)) errors.push(`duplicate taxonomy mapping pair: ${mapping.fromConceptId} to ${mapping.toConceptId}`);
    pairs.add(pair);
    if (!(TAXONOMY_MAPPING_RELATIONS as readonly string[]).includes(mapping.relation)) {
      errors.push(`mapping relation is invalid: ${mapping.mappingId}`);
    }
    if (!(TAXONOMY_MAPPING_METHODS as readonly string[]).includes(mapping.method)) {
      errors.push(`mapping method is invalid: ${mapping.mappingId}`);
    }
    if (!Number.isFinite(mapping.confidence) || mapping.confidence < 0 || mapping.confidence > 1) {
      errors.push(`mapping confidence is invalid: ${mapping.mappingId}`);
    }
    if (mapping.method === "deterministic-label" && (mapping.relation === "exact" || mapping.confidence > 0.89)) {
      errors.push(`deterministic label mapping overclaims equivalence: ${mapping.mappingId}`);
    }
    try {
      validateEvidence(mapping.evidence);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `mapping evidence is invalid: ${mapping.mappingId}`);
    }
    const entry: TaxonomyCrosswalkEntry = {
      fromConceptId: mapping.fromConceptId,
      toConceptId: mapping.toConceptId,
      relation: mapping.relation,
      confidence: mapping.confidence,
      method: mapping.method,
      evidence: mapping.evidence
    };
    if (mapping.mappingId !== mappingId(entry, mappingSet.fromSnapshot, mappingSet.toSnapshot)) {
      errors.push(`mappingId is not provenance-bound: ${mapping.mappingId}`);
    }
  }
  const canonical = {
    mappingVersion: mappingSet.mappingVersion,
    createdAt: mappingSet.createdAt,
    fromSnapshot: mappingSet.fromSnapshot,
    toSnapshot: mappingSet.toSnapshot,
    mappings: mappingSet.mappings
  };
  const expectedHash = sha256(stableStringify(canonical));
  if (mappingSet.contentHash !== expectedHash) errors.push("contentHash does not match canonical mapping content");
  const expectedSetId = `TMSET-${expectedHash.slice("sha256:".length, "sha256:".length + 24).toUpperCase()}`;
  if (mappingSet.mappingSetId !== expectedSetId) errors.push("mappingSetId is not content-bound");
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function rankTaxonomyConcepts(
  query: string,
  snapshot: TaxonomySnapshot,
  options: { readonly limit?: number; readonly minimumScore?: number } = {}
): TaxonomyConceptMatch[] {
  assertSnapshot(snapshot);
  if (!normalizeLabel(query)) throw new Error("Taxonomy mapping query is empty");
  const limit = options.limit ?? 5;
  const minimumScore = options.minimumScore ?? 0.25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Taxonomy mapping limit is invalid");
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) throw new Error("minimumScore is invalid");
  const provenance = taxonomySnapshotReference(snapshot);
  return snapshot.concepts
    .map((concept) => ({ concept, match: bestLabelMatch(query, concept) }))
    .filter(({ match }) => match.score >= minimumScore)
    .sort((left, right) =>
      right.match.score - left.match.score || compareText(left.concept.conceptId, right.concept.conceptId)
    )
    .slice(0, limit)
    .map(({ concept, match }) => Object.freeze({
      conceptId: concept.conceptId,
      score: Number(match.score.toFixed(4)),
      matchedLabel: match.label,
      method: "deterministic-label-v1" as const,
      provenance
    }));
}

export function proposeTaxonomyMappings(
  fromSnapshot: TaxonomySnapshot,
  toSnapshot: TaxonomySnapshot,
  minimumScore = 0.75
): TaxonomyMappingProposal[] {
  assertSnapshot(fromSnapshot);
  assertSnapshot(toSnapshot);
  if (fromSnapshot.source === toSnapshot.source) throw new Error("Mapping proposals require different taxonomy sources");
  if (!Number.isFinite(minimumScore) || minimumScore < 0.5 || minimumScore > 1) throw new Error("minimumScore is invalid");
  const fromReference = taxonomySnapshotReference(fromSnapshot);
  const toReference = taxonomySnapshotReference(toSnapshot);
  const proposals: TaxonomyMappingProposal[] = [];
  for (const fromConcept of fromSnapshot.concepts) {
    let best: { concept: TaxonomyConcept; score: number; fromLabel: string; toLabel: string } | null = null;
    for (const fromLabel of [fromConcept.preferredLabel, ...fromConcept.alternateLabels]) {
      for (const toConcept of toSnapshot.concepts) {
        const match = bestLabelMatch(fromLabel, toConcept);
        if (
          best === null ||
          match.score > best.score ||
          (match.score === best.score && compareText(toConcept.conceptId, best.concept.conceptId) < 0)
        ) {
          best = { concept: toConcept, score: match.score, fromLabel, toLabel: match.label };
        }
      }
    }
    if (best && best.score >= minimumScore) {
      proposals.push(Object.freeze({
        fromConceptId: fromConcept.conceptId,
        toConceptId: best.concept.conceptId,
        relation: "close",
        confidence: Number(Math.min(best.score, 0.89).toFixed(4)),
        method: "deterministic-label",
        matchedLabels: Object.freeze([best.fromLabel, best.toLabel]) as readonly [string, string],
        provenance: Object.freeze({ fromSnapshot: fromReference, toSnapshot: toReference })
      }));
    }
  }
  return proposals.sort((left, right) =>
    compareText(left.fromConceptId, right.fromConceptId) || compareText(left.toConceptId, right.toConceptId)
  );
}
