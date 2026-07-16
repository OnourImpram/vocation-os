import { timingSafeEqual } from "node:crypto";
import { compactVerify, importJWK, type JWK } from "jose";
import { stableStringify } from "../hash.js";
import { parseJsonObjectStrict } from "./envelope.js";
import { CredentialImportError } from "./errors.js";
import type {
  CompactJwsVerificationRequest,
  CredentialCryptoVerificationResult,
  CredentialCryptoVerifier,
  CredentialDocumentLoader,
  DataIntegrityVerificationRequest,
  JsonObject,
  JsonValue
} from "./types.js";

const SUPPORTED_ALGORITHMS = new Set(["RS256", "PS256", "ES256", "EdDSA"]);
const PRIVATE_JWK_FIELDS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k", "priv"]);
const ALLOWED_HEADER_FIELDS = new Set(["alg", "kid", "jwk", "typ"]);
const DEFAULT_MAX_KEY_DOCUMENT_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;

export interface JoseCredentialCryptoVerifierOptions {
  allowedAlgorithms: readonly string[];
  maxKeyDocumentBytes?: number;
}

interface ResolvedVerificationKey {
  jwk: JsonObject;
  keyId: string;
  controller: string | null;
}

class JoseVerifierError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "JoseVerifierError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new JoseVerifierError(code);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(object: JsonObject, field: string): string | null {
  const value = object[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function issuerId(credential: JsonObject): string | null {
  const issuer = credential.issuer;
  if (typeof issuer === "string" && issuer.length > 0) return issuer;
  return isJsonObject(issuer) ? stringField(issuer, "id") : null;
}

function subjectId(credential: JsonObject): string | null {
  const subject = credential.credentialSubject;
  return isJsonObject(subject) ? stringField(subject, "id") : null;
}

function decodeBase64Url(value: string, code: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail(code);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) fail(code);
  return Uint8Array.from(decoded);
}

function decodeJsonSegment(segment: string, code: string): JsonObject {
  const decoded = decodeBase64Url(segment, code);
  try {
    return parseJsonObjectStrict(new TextDecoder("utf-8", { fatal: true }).decode(decoded), MAX_JSON_DEPTH);
  } catch {
    return fail(code);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function assertExactObject(left: JsonObject, right: JsonObject, code: string): void {
  if (stableStringify(left) !== stableStringify(right)) fail(code);
}

function assertAbsoluteKeyId(keyId: string): void {
  if (/\s/u.test(keyId)) fail("jws-key-id-invalid");
  let parsed: URL;
  try {
    parsed = new URL(keyId);
  } catch {
    return fail("jws-key-id-invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "did:") fail("jws-key-id-invalid");
  if (parsed.protocol === "https:" && (parsed.username.length > 0 || parsed.password.length > 0)) {
    fail("jws-key-id-invalid");
  }
}

function keyIdAnchoredToIssuer(keyId: string, issuer: string): boolean {
  if (issuer.startsWith("did:")) {
    return keyId === issuer || keyId.startsWith(`${issuer}#`) || keyId.startsWith(`${issuer}/`);
  }
  try {
    const issuerUrl = new URL(issuer);
    const keyUrl = new URL(keyId);
    if (
      issuerUrl.protocol !== "https:"
      || keyUrl.protocol !== "https:"
      || issuerUrl.origin !== keyUrl.origin
      || issuerUrl.username.length > 0
      || issuerUrl.password.length > 0
      || keyUrl.username.length > 0
      || keyUrl.password.length > 0
    ) {
      return false;
    }
    const issuerPath = issuerUrl.pathname.replace(/\/$/u, "");
    return keyUrl.pathname === issuerPath || keyUrl.pathname.startsWith(`${issuerPath}/`);
  } catch {
    return false;
  }
}

function numericDate(payload: JsonObject, field: string, required: boolean): number | null {
  const value = payload[field];
  if (value === undefined && !required) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("jws-credential-binding-mismatch");
  return value;
}

function assertCredentialBindings(payload: JsonObject, credential: JsonObject, issuer: string): void {
  const expectedSubject = subjectId(credential);
  const expectedCredentialId = stringField(credential, "id");
  const validFrom = stringField(credential, "validFrom") ?? stringField(credential, "issuanceDate");
  if (!expectedSubject || !expectedCredentialId || !validFrom) fail("jws-credential-binding-missing");
  if (
    stringField(payload, "iss") !== issuer
    || stringField(payload, "sub") !== expectedSubject
    || stringField(payload, "jti") !== expectedCredentialId
  ) {
    fail("jws-credential-binding-mismatch");
  }

  const validFromMs = Date.parse(validFrom);
  const notBefore = numericDate(payload, "nbf", true);
  if (!Number.isFinite(validFromMs) || notBefore === null || validFromMs !== notBefore * 1000) {
    fail("jws-credential-binding-mismatch");
  }

  const validUntil = stringField(credential, "validUntil") ?? stringField(credential, "expirationDate");
  const expires = numericDate(payload, "exp", validUntil !== null);
  if (validUntil === null) {
    if (expires !== null) fail("jws-credential-binding-mismatch");
    return;
  }
  const validUntilMs = Date.parse(validUntil);
  if (!Number.isFinite(validUntilMs) || expires === null || validUntilMs !== expires * 1000) {
    fail("jws-credential-binding-mismatch");
  }
}

function assertPublicJwk(jwk: JsonObject, algorithm: string, keyId: string): void {
  for (const field of PRIVATE_JWK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(jwk, field)) fail("jws-private-key-prohibited");
  }
  if (Object.prototype.hasOwnProperty.call(jwk, "x5u")) fail("jws-key-url-prohibited");

  const jwkKeyId = stringField(jwk, "kid");
  if (jwkKeyId !== null && jwkKeyId !== keyId) fail("jws-key-reference-conflict");
  const declaredAlgorithm = stringField(jwk, "alg");
  if (declaredAlgorithm !== null && declaredAlgorithm !== algorithm) fail("jws-key-algorithm-mismatch");
  const use = stringField(jwk, "use");
  if (use !== null && use !== "sig") fail("jws-key-use-invalid");

  const keyOperations = jwk.key_ops;
  if (keyOperations !== undefined) {
    if (
      !Array.isArray(keyOperations)
      || keyOperations.length !== 1
      || keyOperations[0] !== "verify"
    ) {
      fail("jws-key-operations-invalid");
    }
  }

  const keyType = stringField(jwk, "kty");
  if (algorithm === "RS256" || algorithm === "PS256") {
    if (keyType !== "RSA") fail("jws-key-type-mismatch");
    const modulus = decodeBase64Url(stringField(jwk, "n") ?? "", "jws-key-parameters-invalid");
    const exponent = decodeBase64Url(stringField(jwk, "e") ?? "", "jws-key-parameters-invalid");
    if (modulus.byteLength < 256 || (modulus[0] ?? 0) < 0x80 || exponent.byteLength > 8) {
      fail("jws-key-strength-invalid");
    }
    let exponentValue = 0n;
    for (const byte of exponent) exponentValue = (exponentValue << 8n) | BigInt(byte);
    if (exponentValue < 65_537n || exponentValue % 2n === 0n) fail("jws-key-strength-invalid");
    return;
  }

  if (algorithm === "ES256") {
    if (keyType !== "EC" || stringField(jwk, "crv") !== "P-256") fail("jws-key-type-mismatch");
    const x = decodeBase64Url(stringField(jwk, "x") ?? "", "jws-key-parameters-invalid");
    const y = decodeBase64Url(stringField(jwk, "y") ?? "", "jws-key-parameters-invalid");
    if (x.byteLength !== 32 || y.byteLength !== 32) fail("jws-key-parameters-invalid");
    return;
  }

  if (algorithm === "EdDSA") {
    if (keyType !== "OKP" || stringField(jwk, "crv") !== "Ed25519") fail("jws-key-type-mismatch");
    const x = decodeBase64Url(stringField(jwk, "x") ?? "", "jws-key-parameters-invalid");
    if (x.byteLength !== 32) fail("jws-key-parameters-invalid");
    return;
  }

  fail("jws-algorithm-prohibited");
}

function assertionMethodIds(document: JsonObject): Set<string> {
  const value = document.assertionMethod;
  if (value === undefined) return new Set();
  const entries = Array.isArray(value) ? value : [value];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "string") ids.add(entry);
    if (isJsonObject(entry)) {
      const id = stringField(entry, "id");
      if (id !== null) ids.add(id);
    }
  }
  return ids;
}

function extractResolvedKey(document: JsonObject, keyId: string): ResolvedVerificationKey {
  const candidates: ResolvedVerificationKey[] = [];
  const addCandidate = (jwk: JsonObject, id: string | null, controller: string | null): void => {
    if (id === null || id === keyId) candidates.push({ jwk, keyId, controller });
  };

  if (stringField(document, "kty") !== null) {
    addCandidate(document, stringField(document, "kid"), stringField(document, "controller"));
  }
  if (isJsonObject(document.publicKeyJwk)) {
    addCandidate(
      document.publicKeyJwk,
      stringField(document, "id") ?? stringField(document.publicKeyJwk, "kid"),
      stringField(document, "controller")
    );
  }

  const keys = document.keys;
  if (Array.isArray(keys)) {
    for (const value of keys) {
      if (isJsonObject(value) && stringField(value, "kid") === keyId) {
        addCandidate(value, keyId, stringField(value, "controller"));
      }
    }
  }

  const verificationMethods = document.verificationMethod;
  const methodList = Array.isArray(verificationMethods) ? verificationMethods : [verificationMethods];
  for (const method of methodList) {
    if (!isJsonObject(method) || stringField(method, "id") !== keyId || !isJsonObject(method.publicKeyJwk)) continue;
    addCandidate(method.publicKeyJwk, keyId, stringField(method, "controller"));
  }

  if (candidates.length !== 1) fail(candidates.length === 0 ? "jws-key-not-found" : "jws-key-ambiguous");
  const selected = candidates[0]!;
  if (Array.isArray(verificationMethods) && !assertionMethodIds(document).has(keyId)) {
    fail("jws-key-not-authorized-for-assertion");
  }
  return selected;
}

function failureReason(error: unknown): string {
  if (error instanceof JoseVerifierError) return error.code;
  if (error instanceof CredentialImportError) return `jws-key-resolution-${error.code}`;
  return "jws-cryptographic-verification-failed";
}

function invalidResult(
  request: CompactJwsVerificationRequest,
  keyId: string | null,
  reason: string
): CredentialCryptoVerificationResult {
  return {
    valid: false,
    algorithm: request.algorithm,
    signerId: null,
    keyId,
    reasons: [reason]
  };
}

export class JoseCredentialCryptoVerifier implements CredentialCryptoVerifier {
  readonly #allowedAlgorithms: ReadonlySet<string>;
  readonly #maxKeyDocumentBytes: number;

  constructor(options: JoseCredentialCryptoVerifierOptions) {
    if (
      options.allowedAlgorithms.length === 0
      || new Set(options.allowedAlgorithms).size !== options.allowedAlgorithms.length
      || options.allowedAlgorithms.some((algorithm) => !SUPPORTED_ALGORITHMS.has(algorithm))
    ) {
      throw new TypeError("JOSE algorithm allowlist must be non-empty, unique, and supported");
    }
    const maxKeyDocumentBytes = options.maxKeyDocumentBytes ?? DEFAULT_MAX_KEY_DOCUMENT_BYTES;
    if (!Number.isSafeInteger(maxKeyDocumentBytes) || maxKeyDocumentBytes < 1024 || maxKeyDocumentBytes > 1024 * 1024) {
      throw new TypeError("JOSE key document byte limit must be between 1024 and 1048576");
    }
    this.#allowedAlgorithms = new Set(options.allowedAlgorithms);
    this.#maxKeyDocumentBytes = maxKeyDocumentBytes;
  }

  async verifyCompactJws(
    request: CompactJwsVerificationRequest,
    loader: CredentialDocumentLoader
  ): Promise<CredentialCryptoVerificationResult> {
    let effectiveKeyId = request.keyId;
    try {
      if (!this.#allowedAlgorithms.has(request.algorithm)) fail("jws-algorithm-prohibited");
      const segments = request.compactJws.split(".");
      if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) fail("jws-compact-format-invalid");
      const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
      if (`${headerSegment}.${payloadSegment}` !== request.signingInput) fail("jws-signing-input-mismatch");
      const signature = decodeBase64Url(signatureSegment, "jws-signature-encoding-invalid");
      if (!equalBytes(signature, request.signature)) fail("jws-signature-binding-mismatch");

      const header = decodeJsonSegment(headerSegment, "jws-header-invalid");
      const payload = decodeJsonSegment(payloadSegment, "jws-payload-invalid");
      assertExactObject(header, request.header, "jws-header-binding-mismatch");
      assertExactObject(payload, request.payload, "jws-payload-binding-mismatch");
      for (const field of Object.keys(header)) {
        if (!ALLOWED_HEADER_FIELDS.has(field)) fail("jws-header-field-prohibited");
      }
      if (stringField(header, "alg") !== request.algorithm) fail("jws-algorithm-confusion");
      const type = stringField(header, "typ");
      if (type !== null && type !== "JWT") fail("jws-type-invalid");

      const envelopeCredential = isJsonObject(payload.vc) ? payload.vc : payload;
      assertExactObject(envelopeCredential, request.credential, "jws-credential-payload-mismatch");
      const issuer = issuerId(request.credential);
      if (issuer === null) fail("jws-issuer-binding-missing");
      assertCredentialBindings(payload, request.credential, issuer);

      const headerKeyId = stringField(header, "kid");
      if (headerKeyId !== request.keyId) fail("jws-key-reference-conflict");
      const embeddedJwk = isJsonObject(header.jwk) ? header.jwk : null;
      const embeddedKeyId = embeddedJwk === null ? null : stringField(embeddedJwk, "kid");
      effectiveKeyId = headerKeyId ?? embeddedKeyId;
      if (effectiveKeyId === null) fail("jws-key-binding-missing");
      assertAbsoluteKeyId(effectiveKeyId);
      if (embeddedKeyId !== null && embeddedKeyId !== effectiveKeyId) fail("jws-key-reference-conflict");
      if (!keyIdAnchoredToIssuer(effectiveKeyId, issuer)) fail("jws-key-issuer-mismatch");

      let resolved: ResolvedVerificationKey;
      if (embeddedJwk !== null) {
        resolved = { jwk: embeddedJwk, keyId: effectiveKeyId, controller: issuer };
      } else {
        const loaded = await loader.load({
          url: effectiveKeyId,
          purpose: "verification-method",
          maxBytes: this.#maxKeyDocumentBytes
        });
        if (loaded.url !== effectiveKeyId || loaded.bytes.byteLength > this.#maxKeyDocumentBytes) {
          fail("jws-key-document-invalid");
        }
        if (!/^(application\/(json|ld\+json|jwk\+json|jwk-set\+json|did\+ld\+json))(\s*;|$)/iu.test(loaded.mediaType)) {
          fail("jws-key-document-media-type-invalid");
        }
        let keyDocument: JsonObject;
        try {
          keyDocument = parseJsonObjectStrict(
            new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes),
            MAX_JSON_DEPTH
          );
        } catch {
          return invalidResult(request, effectiveKeyId, "jws-key-document-invalid");
        }
        resolved = extractResolvedKey(keyDocument, effectiveKeyId);
        if (resolved.controller !== null && resolved.controller !== issuer) {
          fail("jws-key-issuer-mismatch");
        }
      }

      assertPublicJwk(resolved.jwk, request.algorithm, resolved.keyId);
      const key = await importJWK(resolved.jwk as JWK, request.algorithm);
      if (key instanceof Uint8Array || key.type !== "public") fail("jws-public-key-required");
      const verified = await compactVerify(request.compactJws, key, { algorithms: [request.algorithm] });
      if (verified.protectedHeader.alg !== request.algorithm) fail("jws-algorithm-confusion");
      assertExactObject(verified.protectedHeader as JsonObject, header, "jws-header-binding-mismatch");
      if (!equalBytes(verified.payload, decodeBase64Url(payloadSegment, "jws-payload-invalid"))) {
        fail("jws-payload-binding-mismatch");
      }

      return {
        valid: true,
        algorithm: request.algorithm,
        signerId: issuer,
        keyId: resolved.keyId,
        reasons: []
      };
    } catch (error) {
      return invalidResult(request, effectiveKeyId, failureReason(error));
    }
  }

  async verifyDataIntegrity(
    request: DataIntegrityVerificationRequest,
    _loader: CredentialDocumentLoader
  ): Promise<CredentialCryptoVerificationResult> {
    const proof = request.proofs[0];
    const cryptosuite = isJsonObject(proof) ? stringField(proof, "cryptosuite") : null;
    const algorithm = cryptosuite !== null && request.allowedCryptosuites.includes(cryptosuite)
      ? cryptosuite
      : "unsupported";
    return {
      valid: false,
      algorithm,
      signerId: null,
      keyId: null,
      reasons: ["data-integrity-verification-unsupported"]
    };
  }
}

export function createJoseCredentialCryptoVerifier(
  options: JoseCredentialCryptoVerifierOptions
): CredentialCryptoVerifier {
  return new JoseCredentialCryptoVerifier(options);
}
