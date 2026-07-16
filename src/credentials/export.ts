import { sha256, stableStringify } from "../hash.js";
import { assertCredentialContract } from "./schema.js";
import type { CredentialPassportEntry } from "./types.js";

const EXPORT_FORMAT = "vocation-os-credential-passport-export" as const;
const MAX_EXPORT_SOURCE_BYTES = 8 * 1024 * 1024;

export interface CredentialPassportExportChecksums {
  readonly original: string;
  readonly passport: string;
  readonly verificationReceipt: string;
  readonly mappingManifest: string;
  readonly package: string;
}

export interface CredentialPassportExport {
  readonly format: typeof EXPORT_FORMAT;
  readonly version: 1;
  readonly exportedAt: string;
  readonly passport: CredentialPassportEntry;
  readonly verificationReceipt: CredentialPassportEntry["verification"];
  readonly mappingManifest: CredentialPassportEntry["mappings"];
  readonly original: {
    readonly format: CredentialPassportEntry["original"]["format"];
    readonly mediaType: string;
    readonly byteLength: number;
    readonly contentBase64: string;
  };
  readonly checksums: CredentialPassportExportChecksums;
}

export interface CredentialPassportExportResult {
  readonly value: CredentialPassportExport;
  readonly bytes: Uint8Array;
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Credential export time is invalid");
  }
  return value.toISOString();
}

function packageHash(
  core: Omit<CredentialPassportExport, "checksums">,
  checksums: Omit<CredentialPassportExportChecksums, "package">
): string {
  return sha256(stableStringify({ core, checksums }));
}

function coreFor(
  passport: CredentialPassportEntry,
  originalBytes: Uint8Array,
  exportedAt: string
): Omit<CredentialPassportExport, "checksums"> {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt,
    passport,
    verificationReceipt: passport.verification,
    mappingManifest: passport.mappings,
    original: {
      format: passport.original.format,
      mediaType: passport.original.mediaType,
      byteLength: originalBytes.byteLength,
      contentBase64: Buffer.from(originalBytes).toString("base64")
    }
  };
}

export function createCredentialPassportExport(
  passport: CredentialPassportEntry,
  originalBytes: Uint8Array,
  exportedAt = new Date()
): CredentialPassportExportResult {
  assertCredentialContract("credential-passport", passport);
  if (!(originalBytes instanceof Uint8Array)) {
    throw new Error("Credential export original must be bytes");
  }
  if (originalBytes.byteLength > MAX_EXPORT_SOURCE_BYTES) {
    throw new Error("Credential export original exceeds 8 MiB");
  }
  if (
    originalBytes.byteLength !== passport.original.byteLength
    || sha256(Buffer.from(originalBytes)) !== passport.original.hash
  ) {
    throw new Error("Credential export original does not match the passport artifact binding");
  }
  const core = coreFor(passport, originalBytes, canonicalTimestamp(exportedAt));
  const boundedChecksums = {
    original: passport.original.hash,
    passport: sha256(stableStringify(passport)),
    verificationReceipt: sha256(stableStringify(passport.verification)),
    mappingManifest: sha256(stableStringify(passport.mappings))
  };
  const value: CredentialPassportExport = {
    ...core,
    checksums: {
      ...boundedChecksums,
      package: packageHash(core, boundedChecksums)
    }
  };
  const bytes = new TextEncoder().encode(`${stableStringify(value)}\n`);
  return { value: Object.freeze(value), bytes };
}

export function validateCredentialPassportExport(value: unknown): CredentialPassportExport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Credential export must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = ["checksums", "exportedAt", "format", "mappingManifest", "original", "passport", "verificationReceipt", "version"];
  if (stableStringify(Object.keys(candidate).sort()) !== stableStringify(expectedKeys)) {
    throw new Error("Credential export contains an unexpected field");
  }
  if (candidate["format"] !== EXPORT_FORMAT || candidate["version"] !== 1) {
    throw new Error("Credential export format is unsupported");
  }
  const exportedAt = candidate["exportedAt"];
  if (
    typeof exportedAt !== "string"
    || !Number.isFinite(Date.parse(exportedAt))
    || new Date(Date.parse(exportedAt)).toISOString() !== exportedAt
  ) {
    throw new Error("Credential export time is invalid");
  }
  const passport = candidate["passport"] as CredentialPassportEntry;
  assertCredentialContract("credential-passport", passport);
  if (stableStringify(candidate["verificationReceipt"]) !== stableStringify(passport.verification)) {
    throw new Error("Credential export verification receipt is not bound to the passport");
  }
  if (stableStringify(candidate["mappingManifest"]) !== stableStringify(passport.mappings)) {
    throw new Error("Credential export mapping manifest is not bound to the passport");
  }
  const original = candidate["original"];
  if (typeof original !== "object" || original === null || Array.isArray(original)) {
    throw new Error("Credential export original is invalid");
  }
  const originalValue = original as Record<string, unknown>;
  if (
    stableStringify(Object.keys(originalValue).sort())
      !== stableStringify(["byteLength", "contentBase64", "format", "mediaType"])
    || originalValue["format"] !== passport.original.format
    || originalValue["mediaType"] !== passport.original.mediaType
    || originalValue["byteLength"] !== passport.original.byteLength
    || typeof originalValue["contentBase64"] !== "string"
  ) {
    throw new Error("Credential export original metadata is not bound to the passport");
  }
  const originalBytes = Buffer.from(originalValue["contentBase64"] as string, "base64");
  if (
    originalBytes.toString("base64") !== originalValue["contentBase64"]
    || originalBytes.byteLength !== passport.original.byteLength
    || sha256(originalBytes) !== passport.original.hash
  ) {
    throw new Error("Credential export original checksum is invalid");
  }
  const checksums = candidate["checksums"];
  if (typeof checksums !== "object" || checksums === null || Array.isArray(checksums)) {
    throw new Error("Credential export checksum list is invalid");
  }
  const checksumValue = checksums as Record<string, unknown>;
  if (
    stableStringify(Object.keys(checksumValue).sort())
      !== stableStringify(["mappingManifest", "original", "package", "passport", "verificationReceipt"])
  ) {
    throw new Error("Credential export checksum list contains an unexpected field");
  }
  const boundedChecksums = {
    original: passport.original.hash,
    passport: sha256(stableStringify(passport)),
    verificationReceipt: sha256(stableStringify(passport.verification)),
    mappingManifest: sha256(stableStringify(passport.mappings))
  };
  const core = coreFor(passport, originalBytes, exportedAt);
  if (
    checksumValue["original"] !== boundedChecksums.original
    || checksumValue["passport"] !== boundedChecksums.passport
    || checksumValue["verificationReceipt"] !== boundedChecksums.verificationReceipt
    || checksumValue["mappingManifest"] !== boundedChecksums.mappingManifest
    || checksumValue["package"] !== packageHash(core, boundedChecksums)
  ) {
    throw new Error("Credential export checksum list is invalid");
  }
  return value as CredentialPassportExport;
}

