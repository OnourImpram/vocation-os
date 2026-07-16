import { sha256, stableStringify } from "../hash.js";
import {
  providerManifestById,
  type DiscoveryProviderId
} from "./providers.js";

export const SOURCE_AVAILABILITY_STATES = [
  "available",
  "not-found",
  "gone",
  "access-denied",
  "rate-limited",
  "transport-error",
  "parse-error",
  "uncertain"
] as const;

export const OBSERVATION_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const OBSERVATION_CACHE_STATES = ["hit", "miss", "bypass"] as const;

export type SourceAvailability = (typeof SOURCE_AVAILABILITY_STATES)[number];
export type ObservationConfidence = (typeof OBSERVATION_CONFIDENCE_LEVELS)[number];
export type ObservationCacheState = (typeof OBSERVATION_CACHE_STATES)[number];
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ObservedSourceField {
  readonly field: string;
  readonly value: JsonValue;
  readonly confidence: ObservationConfidence;
  readonly evidencePointer: string;
}

export interface SourceObservationInput {
  readonly providerId: DiscoveryProviderId;
  readonly providerManifestVersion: string;
  readonly sourceKey: string;
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly observedAt: string;
  readonly availability: SourceAvailability;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly bodyDigest: string | null;
  readonly cacheState: ObservationCacheState;
  readonly redirectCount: number;
  readonly fields: readonly ObservedSourceField[];
  readonly uncertainty: readonly string[];
}

export interface SourceObservation extends SourceObservationInput {
  readonly schemaVersion: "1.0.0";
  readonly observationId: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FIELD_PATTERN = /^[a-z][a-zA-Z0-9.-]{0,63}$/;
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO date-time`);
  }
  return value;
}

function canonicalHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name} must be credential-free HTTPS without a fragment`);
  }
  if (url.hostname.endsWith(".")) throw new Error(`${name} must not use a trailing dot hostname`);
  return url.toString();
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, entry]) => key.length > 0 && entry !== undefined && isJsonValue(entry, seen)
  );
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeJson(entry)));
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)]))
    ) as { readonly [key: string]: JsonValue };
  }
  return value;
}

function normalizedField(field: ObservedSourceField): ObservedSourceField {
  if (!FIELD_PATTERN.test(field.field)) throw new Error(`Invalid observed field name: ${field.field}`);
  if (!(OBSERVATION_CONFIDENCE_LEVELS as readonly string[]).includes(field.confidence)) {
    throw new Error(`Invalid confidence for observed field: ${field.field}`);
  }
  if (!field.evidencePointer.trim() || field.evidencePointer.length > 2_048) {
    throw new Error(`Invalid evidence pointer for observed field: ${field.field}`);
  }
  if (!isJsonValue(field.value)) throw new Error(`Observed field is not JSON-safe: ${field.field}`);
  return Object.freeze({
    field: field.field,
    value: freezeJson(field.value),
    confidence: field.confidence,
    evidencePointer: field.evidencePointer.trim()
  });
}

function normalizeUncertainty(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.some((value) => value.length > 1_024)) throw new Error("Uncertainty reason is too long");
  return Object.freeze([...new Set(normalized)].sort(compareText));
}

function assertAvailabilityContract(input: SourceObservationInput): void {
  const status = input.httpStatus;
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error("Source observation has an invalid HTTP status");
  }
  if (input.availability === "available") {
    if (status === null || status < 200 || status > 299) throw new Error("Available observations require a 2xx status");
    if (!input.finalUrl || !input.bodyDigest || !input.contentType) {
      throw new Error("Available observations require final URL, body digest, and content type");
    }
  }
  if (input.availability === "not-found" && status !== 404) {
    throw new Error("Not-found observations require HTTP 404");
  }
  if (input.availability === "gone" && status !== 410) {
    throw new Error("Gone observations require HTTP 410");
  }
  if (input.availability === "access-denied" && status !== null && status !== 401 && status !== 403) {
    throw new Error("Access-denied observations require no HTTP claim or status 401 or 403");
  }
  if (input.availability === "rate-limited" && status !== null && status !== 429) {
    throw new Error("Rate-limited observations require no HTTP claim or status 429");
  }
  if (input.availability === "transport-error" && status !== null) {
    throw new Error("Transport-error observations cannot claim an HTTP status");
  }
  if (input.availability === "parse-error" && (status === null || status < 200 || status > 299)) {
    throw new Error("Parse-error observations require a retrieved 2xx response");
  }
  if (
    input.availability === "parse-error" &&
    (!input.finalUrl || !input.bodyDigest || !input.contentType)
  ) {
    throw new Error("Parse-error observations require retrieved response provenance");
  }
  if (input.availability !== "available" && input.uncertainty.length === 0) {
    throw new Error("Non-available observations require explicit uncertainty");
  }
  if (
    input.availability !== "available" &&
    input.fields.length > 0
  ) {
    throw new Error("Unavailable responses cannot assert extracted fields");
  }
}

export function createSourceObservation(input: SourceObservationInput): SourceObservation {
  const provider = providerManifestById(input.providerId);
  if (input.providerManifestVersion !== provider.egress.version) {
    throw new Error(`Provider manifest version mismatch for ${input.providerId}`);
  }
  if (!input.sourceKey.trim() || input.sourceKey.length > 512) throw new Error("sourceKey is invalid");
  const fields = input.fields.map(normalizedField).sort((left, right) =>
    compareText(left.field, right.field) || compareText(left.evidencePointer, right.evidencePointer)
  );
  if (new Set(fields.map((field) => field.field)).size !== fields.length) {
    throw new Error("Observed field names must be unique");
  }
  const uncertainty = normalizeUncertainty(input.uncertainty);
  const contentType = input.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  if (contentType !== null && !CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new Error("Source observation content type is invalid");
  }
  if (input.bodyDigest !== null && !SHA256_PATTERN.test(input.bodyDigest)) {
    throw new Error("Source observation body digest is invalid");
  }
  if (!(SOURCE_AVAILABILITY_STATES as readonly string[]).includes(input.availability)) {
    throw new Error("Source observation availability is invalid");
  }
  if (!(OBSERVATION_CACHE_STATES as readonly string[]).includes(input.cacheState)) {
    throw new Error("Source observation cache state is invalid");
  }
  if (!Number.isInteger(input.redirectCount) || input.redirectCount < 0 || input.redirectCount > 10) {
    throw new Error("Source observation redirect count is invalid");
  }

  const normalized: SourceObservationInput = {
    providerId: input.providerId,
    providerManifestVersion: input.providerManifestVersion,
    sourceKey: input.sourceKey.trim(),
    requestedUrl: canonicalHttpsUrl(input.requestedUrl, "requestedUrl"),
    finalUrl: input.finalUrl === null ? null : canonicalHttpsUrl(input.finalUrl, "finalUrl"),
    observedAt: canonicalTimestamp(input.observedAt, "observedAt"),
    availability: input.availability,
    httpStatus: input.httpStatus,
    contentType,
    bodyDigest: input.bodyDigest,
    cacheState: input.cacheState,
    redirectCount: input.redirectCount,
    fields: Object.freeze(fields),
    uncertainty
  };
  assertAvailabilityContract(normalized);
  const digest = sha256(stableStringify(normalized)).slice("sha256:".length, "sha256:".length + 32).toUpperCase();
  return Object.freeze({
    schemaVersion: "1.0.0",
    observationId: `OBS-${digest}`,
    ...normalized
  });
}

export function assertSourceObservation(value: SourceObservation): void {
  if (value.schemaVersion !== "1.0.0" || !/^OBS-[A-F0-9]{32}$/.test(value.observationId)) {
    throw new Error("Source observation envelope is invalid");
  }
  const rebuilt = createSourceObservation({
    providerId: value.providerId,
    providerManifestVersion: value.providerManifestVersion,
    sourceKey: value.sourceKey,
    requestedUrl: value.requestedUrl,
    finalUrl: value.finalUrl,
    observedAt: value.observedAt,
    availability: value.availability,
    httpStatus: value.httpStatus,
    contentType: value.contentType,
    bodyDigest: value.bodyDigest,
    cacheState: value.cacheState,
    redirectCount: value.redirectCount,
    fields: value.fields,
    uncertainty: value.uncertainty
  });
  if (stableStringify(rebuilt) !== stableStringify(value)) throw new Error("Source observation integrity check failed");
}
