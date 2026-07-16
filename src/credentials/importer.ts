import { sha256, stableStringify } from "../hash.js";
import { collectCredentialDocumentUrls, createSafeCredentialDocumentLoader } from "./document-loader.js";
import {
  extractCredentialEnvelope,
  OPEN_BADGES_CONTEXT_URL,
  parseJsonObjectStrict,
  VC_CONTEXT_URL
} from "./envelope.js";
import { CredentialImportError } from "./errors.js";
import { parseCompactJws, type ParsedCompactJws } from "./jws.js";
import {
  credentialProofContextUrls,
  credentialStaticDocumentUrls
} from "./local-document-loader.js";
import { assertCredentialContract } from "./schema.js";
import type {
  CredentialCheck,
  CredentialCheckStatus,
  CredentialCryptoVerificationResult,
  CredentialDocumentLoader,
  CredentialImportDependencies,
  CredentialImportOptions,
  CredentialImportResult,
  CredentialImportSource,
  CredentialPassportEntry,
  CredentialSummary,
  CredentialVerificationReport,
  JsonObject,
  JsonValue
} from "./types.js";

const DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_EMBEDDED_CREDENTIAL_BYTES = 1024 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_JSON_DEPTH = 64;
const DEFAULT_ALLOWED_ALGORITHMS = ["RS256"] as const;
const DEFAULT_ALLOWED_CRYPTOSUITES = ["eddsa-rdfc-2022"] as const;
const SUPPORTED_ALGORITHMS = new Set(["RS256", "PS256", "ES256", "EdDSA"]);
const SUPPORTED_CRYPTOSUITES = new Set(["eddsa-rdfc-2022", "ecdsa-rdfc-2019", "ecdsa-sd-2023"]);

interface ContextValidation {
  reasons: string[];
  urls: string[];
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(object: JsonObject, field: string): string | null {
  const value = object[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectId(value: JsonValue | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return isJsonObject(value) ? stringField(value, "id") : null;
}

function subjectObject(credential: JsonObject): JsonObject | null {
  return isJsonObject(credential.credentialSubject) ? credential.credentialSubject : null;
}

function normalizeTypes(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function safeDetails(details: readonly string[]): string[] {
  return details.slice(0, 20).map((detail) =>
    detail
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .trim()
      .slice(0, 500)
  );
}

function check(
  status: CredentialCheckStatus,
  code: string,
  checkedAt: string,
  details: readonly string[] = []
): CredentialCheck {
  return { status, code, checkedAt, details: safeDetails(details) };
}

function verifierFailure(error: unknown): string {
  return error instanceof CredentialImportError ? error.code : "external-verifier-error";
}

function cryptoDetails(result: CredentialCryptoVerificationResult): string[] {
  return [
    `algorithm:${result.algorithm}`,
    ...(result.signerId === null ? [] : [`signer:${result.signerId}`]),
    ...(result.keyId === null ? [] : [`key:${result.keyId}`]),
    ...result.reasons
  ];
}

function validateContext(
  credential: JsonObject,
  allowedContextUrls: ReadonlySet<string>
): ContextValidation {
  const context = credential["@context"];
  if (!Array.isArray(context)) return { reasons: ["jsonld-context-array-required"], urls: [] };
  if (context.length > 8) {
    throw new CredentialImportError("jsonld-context-limit-exceeded", "Credential contains too many JSON-LD contexts");
  }
  const urls: string[] = [];
  for (const value of context) {
    if (typeof value !== "string") {
      throw new CredentialImportError("jsonld-inline-context-prohibited", "Inline JSON-LD contexts are prohibited");
    }
    if (!allowedContextUrls.has(value)) {
      throw new CredentialImportError("jsonld-context-not-allowlisted", `JSON-LD context is not allowlisted: ${value}`);
    }
    urls.push(value);
  }
  const reasons: string[] = [];
  if (urls[0] !== VC_CONTEXT_URL || urls[1] !== OPEN_BADGES_CONTEXT_URL) {
    reasons.push("jsonld-required-context-order-invalid");
  }
  if (new Set(urls).size !== urls.length) reasons.push("jsonld-context-duplicate");
  return { reasons, urls };
}

async function resolveExtensionContexts(
  contextUrls: readonly string[],
  loader: CredentialDocumentLoader,
  maxDocumentBytes: number,
  maxJsonDepth: number
): Promise<string[]> {
  const unresolved: string[] = [];
  const extensionUrls = contextUrls.filter((url) => url !== VC_CONTEXT_URL && url !== OPEN_BADGES_CONTEXT_URL);
  for (const url of extensionUrls) {
    try {
      const loaded = await loader.load({ url, purpose: "context", maxBytes: maxDocumentBytes });
      const text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
      const document = parseJsonObjectStrict(text, maxJsonDepth);
      if (!Object.prototype.hasOwnProperty.call(document, "@context")) {
        unresolved.push(`jsonld-context-document-invalid:${url}`);
      }
    } catch (error) {
      if (
        error instanceof CredentialImportError
        && [
          "document-url-invalid",
          "document-url-prohibited",
          "document-url-private-network",
          "document-url-not-allowlisted",
          "document-redirect-prohibited",
          "document-too-large"
        ].includes(error.code)
      ) {
        throw error;
      }
      unresolved.push(`jsonld-context-unresolved:${url}`);
    }
  }
  return unresolved;
}

function isAbsoluteIdentifier(value: string): boolean {
  if (/\s/u.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function structuralReasons(credential: JsonObject, contextReasons: readonly string[]): string[] {
  const reasons = [...contextReasons];
  const types = normalizeTypes(credential.type);
  if (!types.includes("VerifiableCredential")) reasons.push("verifiable-credential-type-missing");
  if (!types.includes("OpenBadgeCredential")) reasons.push("open-badge-credential-type-missing");
  const id = stringField(credential, "id");
  if (!id || !isAbsoluteIdentifier(id)) reasons.push("credential-id-invalid");
  const issuer = objectId(credential.issuer);
  if (!issuer || !isAbsoluteIdentifier(issuer)) reasons.push("credential-issuer-invalid");
  const subject = subjectObject(credential);
  const subjectId = subject ? stringField(subject, "id") : null;
  if (!subjectId || !isAbsoluteIdentifier(subjectId)) reasons.push("credential-subject-invalid");
  const achievement = subject && isJsonObject(subject.achievement) ? subject.achievement : null;
  if (!achievement) {
    reasons.push("credential-achievement-missing");
  } else {
    const achievementId = stringField(achievement, "id");
    const achievementName = stringField(achievement, "name");
    if (!achievementId || !isAbsoluteIdentifier(achievementId)) reasons.push("achievement-id-invalid");
    if (!achievementName) reasons.push("achievement-name-missing");
    if (!isJsonObject(achievement.criteria)) reasons.push("achievement-criteria-missing");
  }
  const from = stringField(credential, "validFrom") ?? stringField(credential, "issuanceDate");
  if (!from || !Number.isFinite(Date.parse(from))) reasons.push("credential-valid-from-invalid");
  const until = stringField(credential, "validUntil") ?? stringField(credential, "expirationDate");
  if (until !== null && !Number.isFinite(Date.parse(until))) reasons.push("credential-valid-until-invalid");
  if (credential.credentialStatus !== undefined && !isJsonObject(credential.credentialStatus)) {
    reasons.push("credential-status-invalid");
  }
  if (credential.refreshService !== undefined && !isJsonObject(credential.refreshService)) {
    reasons.push("credential-refresh-service-invalid");
  }
  return [...new Set(reasons)].sort();
}

function credentialSummary(credential: JsonObject): CredentialSummary {
  const subject = subjectObject(credential);
  const achievement = subject && isJsonObject(subject.achievement) ? subject.achievement : null;
  return {
    credentialId: stringField(credential, "id"),
    issuerId: objectId(credential.issuer),
    subjectId: subject ? stringField(subject, "id") : null,
    achievementId: achievement ? stringField(achievement, "id") : null,
    achievementName: achievement ? stringField(achievement, "name") : null,
    validFrom: stringField(credential, "validFrom") ?? stringField(credential, "issuanceDate"),
    validUntil: stringField(credential, "validUntil") ?? stringField(credential, "expirationDate")
  };
}

function proofObjects(credential: JsonObject): JsonObject[] {
  const proof = credential.proof;
  if (proof === undefined) return [];
  const values = Array.isArray(proof) ? proof : [proof];
  if (!values.every(isJsonObject)) {
    throw new CredentialImportError("credential-proof-invalid", "Credential proof must be an object or object array");
  }
  return values;
}

function validateAllowedValues(values: readonly string[], supported: ReadonlySet<string>, label: string): string[] {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new CredentialImportError("verification-policy-invalid", `${label} allowlist must be non-empty and unique`);
  }
  for (const value of values) {
    if (!supported.has(value)) {
      throw new CredentialImportError("verification-policy-invalid", `${label} is not supported: ${value}`);
    }
  }
  return [...values];
}

function assertDataIntegrityProofPolicy(proofs: readonly JsonObject[], allowedCryptosuites: readonly string[]): string[] {
  const cryptosuites: string[] = [];
  for (const proof of proofs) {
    if (stringField(proof, "type") !== "DataIntegrityProof") {
      throw new CredentialImportError("credential-proof-type-prohibited", "Only DataIntegrityProof is supported for JSON-LD credentials");
    }
    if (stringField(proof, "proofPurpose") !== "assertionMethod") {
      throw new CredentialImportError("credential-proof-purpose-invalid", "Credential proof purpose must be assertionMethod");
    }
    const cryptosuite = stringField(proof, "cryptosuite");
    if (!cryptosuite || !allowedCryptosuites.includes(cryptosuite)) {
      throw new CredentialImportError("credential-proof-cryptosuite-prohibited", "Credential proof cryptosuite is not allowed");
    }
    cryptosuites.push(cryptosuite);
  }
  return cryptosuites;
}

async function verifySignature(
  parsedJws: ParsedCompactJws | null,
  credential: JsonObject,
  dependencies: CredentialImportDependencies,
  loader: Parameters<NonNullable<CredentialImportDependencies["cryptoVerifier"]>["verifyCompactJws"]>[1],
  allowedCryptosuites: readonly string[],
  checkedAt: string
): Promise<{ check: CredentialCheck; result: CredentialCryptoVerificationResult | null }> {
  const verifier = dependencies.cryptoVerifier;
  if (parsedJws) {
    if (!verifier) return { check: check("not-checked", "unsupported-proof", checkedAt), result: null };
    try {
      const result = await verifier.verifyCompactJws(
        {
          compactJws: parsedJws.compactJws,
          signingInput: parsedJws.signingInput,
          signature: Uint8Array.from(parsedJws.signature),
          algorithm: parsedJws.algorithm,
          keyId: parsedJws.keyId,
          header: parsedJws.header,
          payload: parsedJws.payload,
          credential: parsedJws.credential
        },
        loader
      );
      if (result.algorithm !== parsedJws.algorithm) {
        return {
          check: check("fail", "signature-algorithm-confusion", checkedAt, cryptoDetails(result)),
          result
        };
      }
      if (parsedJws.keyId !== null && result.keyId !== parsedJws.keyId) {
        return { check: check("fail", "signature-key-mismatch", checkedAt, cryptoDetails(result)), result };
      }
      return {
        check: result.valid
          ? check("pass", "signature-valid", checkedAt, cryptoDetails(result))
          : check("fail", "signature-invalid", checkedAt, cryptoDetails(result)),
        result
      };
    } catch (error) {
      return { check: check("fail", "signature-verifier-failed", checkedAt, [verifierFailure(error)]), result: null };
    }
  }

  const proofs = proofObjects(credential);
  if (proofs.length === 0) return { check: check("not-checked", "signature-not-present", checkedAt), result: null };
  const cryptosuites = assertDataIntegrityProofPolicy(proofs, allowedCryptosuites);
  if (!verifier) return { check: check("not-checked", "unsupported-proof", checkedAt), result: null };
  try {
    const result = await verifier.verifyDataIntegrity(
      { credential, proofs, allowedCryptosuites },
      loader
    );
    if (!cryptosuites.includes(result.algorithm)) {
      return {
        check: check("fail", "signature-algorithm-confusion", checkedAt, cryptoDetails(result)),
        result
      };
    }
    return {
      check: result.valid
        ? check("pass", "signature-valid", checkedAt, cryptoDetails(result))
        : check("fail", "signature-invalid", checkedAt, cryptoDetails(result)),
      result
    };
  } catch (error) {
    return { check: check("fail", "signature-verifier-failed", checkedAt, [verifierFailure(error)]), result: null };
  }
}

async function verifySchema(
  credential: JsonObject,
  structural: readonly string[],
  dependencies: CredentialImportDependencies,
  loader: Parameters<NonNullable<CredentialImportDependencies["schemaVerifier"]>["validate"]>[1],
  checkedAt: string
): Promise<CredentialCheck> {
  if (structural.length > 0) return check("fail", "credential-structure-invalid", checkedAt, structural);
  if (!dependencies.schemaVerifier) return check("not-checked", "schema-verifier-unavailable", checkedAt);
  try {
    const result = await dependencies.schemaVerifier.validate(credential, loader);
    return result.valid
      ? check("pass", "open-badges-schema-valid", checkedAt, result.reasons)
      : check("fail", "open-badges-schema-invalid", checkedAt, result.reasons);
  } catch (error) {
    return check("fail", "schema-verifier-failed", checkedAt, [verifierFailure(error)]);
  }
}

function verifyIssuer(
  summary: CredentialSummary,
  signature: CredentialCheck,
  cryptoResult: CredentialCryptoVerificationResult | null,
  checkedAt: string
): CredentialCheck {
  if (!summary.issuerId) return check("fail", "issuer-id-missing", checkedAt);
  if (summary.subjectId !== null && summary.issuerId === summary.subjectId) {
    return check("fail", "self-asserted-issuer-not-independent", checkedAt);
  }
  if (signature.status === "fail") return check("fail", "issuer-signature-invalid", checkedAt);
  if (signature.status !== "pass" || !cryptoResult) return check("not-checked", "issuer-not-cryptographically-bound", checkedAt);
  if (cryptoResult.signerId === null) return check("not-checked", "issuer-signer-identity-unavailable", checkedAt);
  if (cryptoResult.signerId !== summary.issuerId) {
    return check("fail", "issuer-signer-mismatch", checkedAt, [cryptoResult.signerId]);
  }
  return check("pass", "issuer-verified", checkedAt);
}

function verifySubject(summary: CredentialSummary, expectedSubjectId: string | undefined, checkedAt: string): CredentialCheck {
  if (!summary.subjectId) return check("fail", "subject-id-missing", checkedAt);
  if (expectedSubjectId === undefined) return check("not-checked", "expected-subject-not-provided", checkedAt);
  return summary.subjectId === expectedSubjectId
    ? check("pass", "subject-matched", checkedAt)
    : check("fail", "subject-mismatch", checkedAt);
}

function verifyTime(summary: CredentialSummary, nowMs: number, checkedAt: string): CredentialCheck {
  if (!summary.validFrom) return check("fail", "credential-valid-from-missing", checkedAt);
  const from = Date.parse(summary.validFrom);
  if (!Number.isFinite(from)) return check("fail", "credential-valid-from-invalid", checkedAt);
  if (from > nowMs) return check("fail", "credential-not-yet-valid", checkedAt);
  if (summary.validUntil !== null) {
    const until = Date.parse(summary.validUntil);
    if (!Number.isFinite(until)) return check("fail", "credential-valid-until-invalid", checkedAt);
    if (until <= from) return check("fail", "credential-validity-window-invalid", checkedAt);
    if (until <= nowMs) return check("fail", "credential-expired", checkedAt);
  }
  return check("pass", "credential-time-valid", checkedAt);
}

async function verifyRevocation(
  credential: JsonObject,
  dependencies: CredentialImportDependencies,
  loader: Parameters<NonNullable<CredentialImportDependencies["statusVerifier"]>["checkRevocation"]>[2],
  checkedAt: string
): Promise<CredentialCheck> {
  const status = credential.credentialStatus;
  if (status === undefined) return check("not-applicable", "credential-status-not-present", checkedAt);
  if (!isJsonObject(status)) return check("fail", "credential-status-invalid", checkedAt);
  if (!dependencies.statusVerifier) return check("not-checked", "status-verifier-unavailable", checkedAt);
  try {
    const result = await dependencies.statusVerifier.checkRevocation(credential, status, loader);
    if (!result.checked) return check("not-checked", "revocation-not-checked", checkedAt, result.reasons);
    return result.revoked
      ? check("fail", "credential-revoked", checkedAt, result.reasons)
      : check("pass", "credential-not-revoked", checkedAt, result.reasons);
  } catch (error) {
    return check("fail", "revocation-check-failed", checkedAt, [verifierFailure(error)]);
  }
}

async function verifyRefresh(
  credential: JsonObject,
  dependencies: CredentialImportDependencies,
  loader: Parameters<NonNullable<CredentialImportDependencies["statusVerifier"]>["checkRefresh"]>[2],
  checkedAt: string
): Promise<CredentialCheck> {
  const refreshService = credential.refreshService;
  if (refreshService === undefined) return check("not-applicable", "refresh-service-not-present", checkedAt);
  if (!isJsonObject(refreshService)) return check("fail", "refresh-service-invalid", checkedAt);
  if (!dependencies.statusVerifier) return check("not-checked", "refresh-verifier-unavailable", checkedAt);
  try {
    const result = await dependencies.statusVerifier.checkRefresh(credential, refreshService, loader);
    if (!result.checked) return check("not-checked", "refresh-not-checked", checkedAt, result.reasons);
    return result.valid
      ? check("pass", "refresh-valid", checkedAt, result.reasons)
      : check("fail", "refresh-invalid", checkedAt, result.reasons);
  } catch (error) {
    return check("fail", "refresh-check-failed", checkedAt, [verifierFailure(error)]);
  }
}

function verificationReport(checks: Omit<CredentialVerificationReport, "overall" | "eligibleForMapping">): CredentialVerificationReport {
  const values = Object.values(checks);
  const rejected = values.some((item) => item.status === "fail");
  const requiredPass = [checks.schema, checks.signature, checks.issuer, checks.subject, checks.time]
    .every((item) => item.status === "pass");
  const revocationAccepted = checks.revocation.status === "pass" || checks.revocation.status === "not-applicable";
  const refreshAccepted = checks.refresh.status === "pass" || checks.refresh.status === "not-applicable";
  const verified = !rejected && requiredPass && revocationAccepted && refreshAccepted;
  return {
    ...checks,
    overall: rejected ? "rejected" : verified ? "verified" : "incomplete",
    eligibleForMapping: verified
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function importCredential(
  source: CredentialImportSource,
  dependencies: CredentialImportDependencies = {},
  options: CredentialImportOptions = {}
): Promise<CredentialImportResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new CredentialImportError("credential-time-invalid", "Import time is invalid");
  const checkedAt = now.toISOString();
  const allowedAlgorithms = validateAllowedValues(
    options.allowedAlgorithms ?? DEFAULT_ALLOWED_ALGORITHMS,
    SUPPORTED_ALGORITHMS,
    "JWS algorithm"
  );
  const allowedCryptosuites = validateAllowedValues(
    options.allowedCryptosuites ?? DEFAULT_ALLOWED_CRYPTOSUITES,
    SUPPORTED_CRYPTOSUITES,
    "Data Integrity cryptosuite"
  );
  const maxJsonDepth = options.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const envelope = extractCredentialEnvelope(source, {
    maxInputBytes: options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    maxEmbeddedCredentialBytes: options.maxEmbeddedCredentialBytes ?? DEFAULT_MAX_EMBEDDED_CREDENTIAL_BYTES,
    maxJsonDepth
  });

  let parsedJws: ParsedCompactJws | null = null;
  let credential: JsonObject;
  if (envelope.envelopeFormat === "compact-jws") {
    parsedJws = parseCompactJws(envelope.serializedCredential, allowedAlgorithms, maxJsonDepth);
    credential = parsedJws.credential;
  } else {
    credential = parseJsonObjectStrict(envelope.serializedCredential, maxJsonDepth);
  }

  const allowedContextUrls = new Set([
    VC_CONTEXT_URL,
    OPEN_BADGES_CONTEXT_URL,
    ...credentialProofContextUrls(),
    ...(options.allowedContextUrls ?? [])
  ]);
  const contextValidation = validateContext(credential, allowedContextUrls);
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const allowedDocumentUrls = new Set(collectCredentialDocumentUrls(
    credential,
    parsedJws?.keyId ?? null,
    contextValidation.urls,
    options.allowedDocumentUrls ?? []
  ));
  for (const staticUrl of credentialStaticDocumentUrls()) allowedDocumentUrls.add(staticUrl);
  const safeLoader = createSafeCredentialDocumentLoader(
    dependencies.documentLoader,
    allowedDocumentUrls,
    maxDocumentBytes
  );

  const unresolvedContexts = await resolveExtensionContexts(
    contextValidation.urls,
    safeLoader,
    maxDocumentBytes,
    maxJsonDepth
  );
  const structural = structuralReasons(
    credential,
    [...contextValidation.reasons, ...unresolvedContexts]
  );

  const schema = await verifySchema(credential, structural, dependencies, safeLoader, checkedAt);
  const signatureVerification = await verifySignature(
    parsedJws,
    credential,
    dependencies,
    safeLoader,
    allowedCryptosuites,
    checkedAt
  );
  const summary = credentialSummary(credential);
  const issuer = verifyIssuer(summary, signatureVerification.check, signatureVerification.result, checkedAt);
  const subject = verifySubject(summary, options.expectedSubjectId, checkedAt);
  const time = verifyTime(summary, nowMs, checkedAt);
  const refresh = credential.refreshService === undefined || signatureVerification.check.status === "pass"
    ? await verifyRefresh(credential, dependencies, safeLoader, checkedAt)
    : check("not-checked", "refresh-blocked-unverified-original", checkedAt);
  const revocation = await verifyRevocation(credential, dependencies, safeLoader, checkedAt);
  const verification = verificationReport({
    schema,
    signature: signatureVerification.check,
    issuer,
    subject,
    time,
    revocation,
    refresh
  });

  const originalHash = sha256(Buffer.from(envelope.originalBytes));
  const canonicalCredentialHash = sha256(stableStringify(credential));
  const entry: CredentialPassportEntry = {
    schemaVersion: 1,
    passportEntryId: `CREDENTIAL-${originalHash.slice("sha256:".length).toUpperCase()}`,
    importedAt: checkedAt,
    original: {
      hash: originalHash,
      byteLength: envelope.originalBytes.byteLength,
      format: envelope.sourceFormat,
      mediaType: envelope.mediaType
    },
    envelopeFormat: envelope.envelopeFormat,
    canonicalCredentialHash,
    credential,
    summary,
    verification,
    mappings: []
  };
  assertCredentialContract("credential-passport", entry);
  return {
    entry: deepFreeze(entry),
    preservedOriginal: {
      ...entry.original,
      bytes: Uint8Array.from(envelope.originalBytes)
    }
  };
}

export const importCredentialPassport = importCredential;
