import { sha256, stableStringify } from "../hash.js";

export const TAXONOMY_SOURCES = ["esco", "onet"] as const;

export type TaxonomySource = (typeof TAXONOMY_SOURCES)[number];
export type TaxonomySnapshotCompleteness = "full" | "partial";

export interface TaxonomyLicense {
  readonly name: string;
  readonly url: string;
}

export interface TaxonomyConceptInput {
  readonly conceptId: string;
  readonly code: string;
  readonly preferredLabel: string;
  readonly language: string;
  readonly alternateLabels?: readonly string[];
  readonly description?: string | null;
  readonly broaderConceptIds?: readonly string[];
  readonly skillIds?: readonly string[];
}

export interface TaxonomyConcept {
  readonly conceptId: string;
  readonly code: string;
  readonly preferredLabel: string;
  readonly language: string;
  readonly alternateLabels: readonly string[];
  readonly description: string | null;
  readonly broaderConceptIds: readonly string[];
  readonly skillIds: readonly string[];
}

export interface TaxonomySnapshotInput {
  readonly source: TaxonomySource;
  readonly version: string;
  readonly completeness: TaxonomySnapshotCompleteness;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly publishedAt?: string | null;
  readonly license: TaxonomyLicense;
  readonly concepts: readonly TaxonomyConceptInput[];
}

export interface TaxonomySnapshot {
  readonly snapshotId: string;
  readonly source: TaxonomySource;
  readonly version: string;
  readonly completeness: TaxonomySnapshotCompleteness;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly publishedAt: string | null;
  readonly license: TaxonomyLicense;
  readonly conceptCount: number;
  readonly concepts: readonly TaxonomyConcept[];
  readonly contentHash: string;
  readonly provenanceHash: string;
}

export type TaxonomySnapshotValidationResult =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly string[] };

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function cleanText(value: string, label: string, maximum = 2_000): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > maximum || /[\0]/.test(cleaned)) throw new Error(`${label} is invalid`);
  return cleaned;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO date-time`);
  }
  return value;
}

function sortedUnique(values: readonly string[] | undefined, label: string): string[] {
  const cleaned = (values ?? []).map((value) => cleanText(value, label, 512));
  const normalized = new Map<string, string>();
  for (const value of cleaned) {
    const key = value.normalize("NFKC").toLowerCase();
    const existing = normalized.get(key);
    if (existing === undefined || compareText(value, existing) < 0) normalized.set(key, value);
  }
  return [...normalized.values()].sort(compareText);
}

function canonicalConcept(input: TaxonomyConceptInput): TaxonomyConcept {
  const conceptId = cleanText(input.conceptId, "conceptId", 512);
  const alternateLabels = sortedUnique(input.alternateLabels, "alternateLabels");
  const preferredLabel = cleanText(input.preferredLabel, "preferredLabel", 512);
  const preferredKey = preferredLabel.normalize("NFKC").toLowerCase();
  return Object.freeze({
    conceptId,
    code: cleanText(input.code, "code", 128),
    preferredLabel,
    language: cleanText(input.language, "language", 32).toLowerCase(),
    alternateLabels: Object.freeze(alternateLabels.filter((label) => label.normalize("NFKC").toLowerCase() !== preferredKey)),
    description: input.description === undefined || input.description === null
      ? null
      : cleanText(input.description, "description", 20_000),
    broaderConceptIds: Object.freeze(sortedUnique(input.broaderConceptIds, "broaderConceptIds")),
    skillIds: Object.freeze(sortedUnique(input.skillIds, "skillIds"))
  });
}

function contentForHash(snapshot: Omit<TaxonomySnapshot, "snapshotId" | "contentHash" | "provenanceHash">): unknown {
  return {
    source: snapshot.source,
    version: snapshot.version,
    completeness: snapshot.completeness,
    concepts: snapshot.concepts
  };
}

function provenanceForHash(
  snapshot: Omit<TaxonomySnapshot, "snapshotId" | "contentHash" | "provenanceHash">
): unknown {
  return {
    source: snapshot.source,
    version: snapshot.version,
    sourceUrl: snapshot.sourceUrl,
    retrievedAt: snapshot.retrievedAt,
    publishedAt: snapshot.publishedAt,
    license: snapshot.license
  };
}

function snapshotId(
  source: TaxonomySource,
  version: string,
  contentHash: string,
  provenanceHash: string
): string {
  const versionToken = version
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 32) || "UNVERSIONED";
  const digest = sha256(stableStringify({ contentHash, provenanceHash }))
    .slice("sha256:".length, "sha256:".length + 20)
    .toUpperCase();
  return `TAX-${source.toUpperCase()}-${versionToken}-${digest}`;
}

export function validateTaxonomySnapshot(snapshot: TaxonomySnapshot): TaxonomySnapshotValidationResult {
  const errors: string[] = [];
  if (!(TAXONOMY_SOURCES as readonly string[]).includes(snapshot.source)) errors.push("source is invalid");
  if (!snapshot.version.trim() || snapshot.version.length > 64) errors.push("version is invalid");
  if (snapshot.completeness !== "full" && snapshot.completeness !== "partial") errors.push("completeness is invalid");
  if (!isHttpsUrl(snapshot.sourceUrl)) errors.push("sourceUrl must be governed HTTPS");
  if (
    !Number.isFinite(Date.parse(snapshot.retrievedAt)) ||
    new Date(Date.parse(snapshot.retrievedAt)).toISOString() !== snapshot.retrievedAt
  ) errors.push("retrievedAt is invalid");
  if (
    snapshot.publishedAt !== null &&
    (!Number.isFinite(Date.parse(snapshot.publishedAt)) ||
      new Date(Date.parse(snapshot.publishedAt)).toISOString() !== snapshot.publishedAt)
  ) errors.push("publishedAt is invalid");
  if (snapshot.publishedAt !== null && Date.parse(snapshot.publishedAt) > Date.parse(snapshot.retrievedAt)) {
    errors.push("publishedAt cannot be after retrievedAt");
  }
  if (!snapshot.license.name.trim() || snapshot.license.name.length > 256) errors.push("license name is invalid");
  if (!isHttpsUrl(snapshot.license.url)) errors.push("license URL must be governed HTTPS");
  if (snapshot.conceptCount !== snapshot.concepts.length) errors.push("conceptCount does not match concepts");
  const ids = new Set<string>();
  for (const concept of snapshot.concepts) {
    if (ids.has(concept.conceptId)) errors.push(`duplicate conceptId: ${concept.conceptId}`);
    ids.add(concept.conceptId);
    if (!concept.conceptId.startsWith(`${snapshot.source}:`)) {
      errors.push(`conceptId is not bound to snapshot source: ${concept.conceptId}`);
    }
    if (!concept.conceptId.trim() || !concept.code.trim() || !concept.preferredLabel.trim()) {
      errors.push(`concept contains an empty identity field: ${concept.conceptId}`);
    }
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(concept.language)) {
      errors.push(`concept language is invalid: ${concept.conceptId}`);
    }
    if (new Set(concept.alternateLabels).size !== concept.alternateLabels.length) {
      errors.push(`concept alternateLabels contain duplicates: ${concept.conceptId}`);
    }
    if (new Set(concept.broaderConceptIds).size !== concept.broaderConceptIds.length) {
      errors.push(`concept broaderConceptIds contain duplicates: ${concept.conceptId}`);
    }
    if (new Set(concept.skillIds).size !== concept.skillIds.length) {
      errors.push(`concept skillIds contain duplicates: ${concept.conceptId}`);
    }
    if (concept.broaderConceptIds.includes(concept.conceptId)) errors.push(`concept cannot be broader than itself: ${concept.conceptId}`);
  }
  if (snapshot.completeness === "full") {
    for (const concept of snapshot.concepts) {
      for (const broaderId of concept.broaderConceptIds) {
        if (!ids.has(broaderId)) errors.push(`full snapshot is missing broader concept: ${broaderId}`);
      }
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshot.contentHash)) errors.push("contentHash is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshot.provenanceHash)) errors.push("provenanceHash is invalid");
  const canonicalWithoutHashes: Omit<TaxonomySnapshot, "snapshotId" | "contentHash" | "provenanceHash"> = {
    source: snapshot.source,
    version: snapshot.version,
    completeness: snapshot.completeness,
    sourceUrl: snapshot.sourceUrl,
    retrievedAt: snapshot.retrievedAt,
    publishedAt: snapshot.publishedAt,
    license: snapshot.license,
    conceptCount: snapshot.conceptCount,
    concepts: snapshot.concepts
  };
  const expectedHash = sha256(stableStringify(contentForHash(canonicalWithoutHashes)));
  if (snapshot.contentHash !== expectedHash) errors.push("contentHash does not match canonical taxonomy content");
  const expectedProvenanceHash = sha256(stableStringify(provenanceForHash(canonicalWithoutHashes)));
  if (snapshot.provenanceHash !== expectedProvenanceHash) {
    errors.push("provenanceHash does not match canonical taxonomy provenance");
  }
  if (snapshot.snapshotId !== snapshotId(snapshot.source, snapshot.version, expectedHash, expectedProvenanceHash)) {
    errors.push("snapshotId is not bound to source, version, content, and provenance");
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function createTaxonomySnapshot(input: TaxonomySnapshotInput): TaxonomySnapshot {
  if (!(TAXONOMY_SOURCES as readonly string[]).includes(input.source)) throw new Error("Taxonomy source is invalid");
  const version = cleanText(input.version, "version", 64);
  if (!isHttpsUrl(input.sourceUrl)) throw new Error("Taxonomy sourceUrl must be governed HTTPS");
  const retrievedAt = canonicalTimestamp(input.retrievedAt, "Taxonomy retrievedAt");
  const publishedAt = input.publishedAt ?? null;
  if (publishedAt !== null) canonicalTimestamp(publishedAt, "Taxonomy publishedAt");
  if (publishedAt !== null && Date.parse(publishedAt) > Date.parse(retrievedAt)) {
    throw new Error("Taxonomy publishedAt cannot be after retrievedAt");
  }
  if (!isHttpsUrl(input.license.url)) throw new Error("Taxonomy license URL must be governed HTTPS");
  const concepts = input.concepts.map(canonicalConcept).sort((left, right) => compareText(left.conceptId, right.conceptId));
  const duplicate = concepts.find((concept, index) => concepts[index - 1]?.conceptId === concept.conceptId);
  if (duplicate) throw new Error(`Duplicate taxonomy concept: ${duplicate.conceptId}`);
  if (concepts.some((concept) => !concept.conceptId.startsWith(`${input.source}:`))) {
    throw new Error("Taxonomy conceptId must be bound to its source");
  }
  const canonical: Omit<TaxonomySnapshot, "snapshotId" | "contentHash" | "provenanceHash"> = {
    source: input.source,
    version,
    completeness: input.completeness,
    sourceUrl: new URL(input.sourceUrl).toString(),
    retrievedAt,
    publishedAt,
    license: Object.freeze({
      name: cleanText(input.license.name, "license name", 256),
      url: new URL(input.license.url).toString()
    }),
    conceptCount: concepts.length,
    concepts: Object.freeze(concepts)
  };
  const contentHash = sha256(stableStringify(contentForHash(canonical)));
  const provenanceHash = sha256(stableStringify(provenanceForHash(canonical)));
  const snapshot: TaxonomySnapshot = Object.freeze({
    snapshotId: snapshotId(input.source, version, contentHash, provenanceHash),
    ...canonical,
    contentHash,
    provenanceHash
  });
  const validation = validateTaxonomySnapshot(snapshot);
  if (!validation.valid) throw new Error(`TaxonomySnapshot validation failed: ${validation.errors.join("; ")}`);
  return snapshot;
}

export interface TaxonomySnapshotReference {
  readonly snapshotId: string;
  readonly source: TaxonomySource;
  readonly version: string;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly publishedAt: string | null;
  readonly license: TaxonomyLicense;
  readonly contentHash: string;
  readonly provenanceHash: string;
}

export function taxonomySnapshotReference(snapshot: TaxonomySnapshot): TaxonomySnapshotReference {
  const validation = validateTaxonomySnapshot(snapshot);
  if (!validation.valid) throw new Error(`Invalid taxonomy snapshot: ${validation.errors.join("; ")}`);
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    source: snapshot.source,
    version: snapshot.version,
    sourceUrl: snapshot.sourceUrl,
    retrievedAt: snapshot.retrievedAt,
    publishedAt: snapshot.publishedAt,
    license: Object.freeze({ ...snapshot.license }),
    contentHash: snapshot.contentHash,
    provenanceHash: snapshot.provenanceHash
  });
}

export function validateTaxonomySnapshotReference(
  reference: TaxonomySnapshotReference
): TaxonomySnapshotValidationResult {
  const errors: string[] = [];
  if (!(TAXONOMY_SOURCES as readonly string[]).includes(reference.source)) errors.push("reference source is invalid");
  if (!reference.version.trim() || reference.version.length > 64) errors.push("reference version is invalid");
  if (!isHttpsUrl(reference.sourceUrl)) errors.push("reference sourceUrl must be governed HTTPS");
  try {
    canonicalTimestamp(reference.retrievedAt, "reference retrievedAt");
    if (reference.publishedAt !== null) canonicalTimestamp(reference.publishedAt, "reference publishedAt");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "reference timestamp is invalid");
  }
  if (reference.publishedAt !== null && Date.parse(reference.publishedAt) > Date.parse(reference.retrievedAt)) {
    errors.push("reference publishedAt cannot be after retrievedAt");
  }
  if (
    !reference.license.name.trim() ||
    reference.license.name.length > 256 ||
    !isHttpsUrl(reference.license.url)
  ) errors.push("reference license is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(reference.contentHash)) errors.push("reference contentHash is invalid");
  const expectedProvenanceHash = sha256(stableStringify({
    source: reference.source,
    version: reference.version,
    sourceUrl: reference.sourceUrl,
    retrievedAt: reference.retrievedAt,
    publishedAt: reference.publishedAt,
    license: reference.license
  }));
  if (reference.provenanceHash !== expectedProvenanceHash) {
    errors.push("reference provenanceHash does not match canonical taxonomy provenance");
  }
  if (reference.snapshotId !== snapshotId(
    reference.source,
    reference.version,
    reference.contentHash,
    expectedProvenanceHash
  )) {
    errors.push("reference snapshotId is not bound to content and provenance");
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}
