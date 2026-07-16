import { CredentialImportError } from "./errors.js";
import { parseJsonObjectStrict } from "./envelope.js";
import type { JsonObject, JsonValue } from "./types.js";

const ALLOWED_HEADER_FIELDS = new Set(["alg", "kid", "jwk", "typ"]);
const PRIVATE_JWK_FIELDS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

export interface ParsedCompactJws {
  compactJws: string;
  signingInput: string;
  signature: Uint8Array;
  algorithm: string;
  keyId: string | null;
  header: JsonObject;
  payload: JsonObject;
  credential: JsonObject;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64Url(segment: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) {
    throw new CredentialImportError("jws-base64url-invalid", `Compact JWS ${label} is not canonical base64url`);
  }
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.toString("base64url") !== segment) {
    throw new CredentialImportError("jws-base64url-invalid", `Compact JWS ${label} is not canonical base64url`);
  }
  return Uint8Array.from(decoded);
}

function decodeJsonSegment(segment: string, label: string, maxJsonDepth: number): JsonObject {
  const decoded = decodeBase64Url(segment, label);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new CredentialImportError("jws-json-utf8-invalid", `Compact JWS ${label} is not valid UTF-8`);
  }
  return parseJsonObjectStrict(text, maxJsonDepth);
}

function stringField(object: JsonObject, field: string): string | null {
  const value = object[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function issuerId(credential: JsonObject): string | null {
  const issuer = credential.issuer;
  if (typeof issuer === "string") return issuer;
  return isJsonObject(issuer) ? stringField(issuer, "id") : null;
}

function subjectId(credential: JsonObject): string | null {
  const subject = credential.credentialSubject;
  return isJsonObject(subject) ? stringField(subject, "id") : null;
}

function validFrom(credential: JsonObject): string | null {
  return stringField(credential, "validFrom") ?? stringField(credential, "issuanceDate");
}

function validUntil(credential: JsonObject): string | null {
  return stringField(credential, "validUntil") ?? stringField(credential, "expirationDate");
}

function numericDate(payload: JsonObject, field: string, required: boolean): number | null {
  const value = payload[field];
  if (value === undefined && !required) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CredentialImportError("jws-claim-invalid", `Compact JWS ${field} claim must be an integer NumericDate`);
  }
  return value;
}

function assertJwtBindings(payload: JsonObject, credential: JsonObject): void {
  const expectedIssuer = issuerId(credential);
  const expectedSubject = subjectId(credential);
  const expectedCredentialId = stringField(credential, "id");
  const expectedValidFrom = validFrom(credential);
  if (!expectedIssuer || !expectedSubject || !expectedCredentialId || !expectedValidFrom) {
    throw new CredentialImportError("jws-credential-binding-missing", "Compact JWS credential lacks required binding fields");
  }
  if (stringField(payload, "iss") !== expectedIssuer) {
    throw new CredentialImportError("jws-issuer-binding-mismatch", "Compact JWS iss does not match credential issuer");
  }
  if (stringField(payload, "sub") !== expectedSubject) {
    throw new CredentialImportError("jws-subject-binding-mismatch", "Compact JWS sub does not match credential subject");
  }
  if (stringField(payload, "jti") !== expectedCredentialId) {
    throw new CredentialImportError("jws-id-binding-mismatch", "Compact JWS jti does not match credential id");
  }
  const notBefore = numericDate(payload, "nbf", true)!;
  const validFromMs = Date.parse(expectedValidFrom);
  if (!Number.isFinite(validFromMs) || validFromMs !== notBefore * 1000) {
    throw new CredentialImportError("jws-time-binding-mismatch", "Compact JWS nbf does not match credential validFrom");
  }
  const expectedValidUntil = validUntil(credential);
  const expires = numericDate(payload, "exp", expectedValidUntil !== null);
  if (expectedValidUntil !== null) {
    const validUntilMs = Date.parse(expectedValidUntil);
    if (expires === null || !Number.isFinite(validUntilMs) || validUntilMs !== expires * 1000) {
      throw new CredentialImportError("jws-time-binding-mismatch", "Compact JWS exp does not match credential validUntil");
    }
  } else if (expires !== null) {
    throw new CredentialImportError("jws-time-binding-mismatch", "Compact JWS exp exists without credential validUntil");
  }
}

function assertJwkSafe(jwk: JsonObject, algorithm: string): void {
  for (const field of Object.keys(jwk)) {
    if (PRIVATE_JWK_FIELDS.has(field)) {
      throw new CredentialImportError("jws-private-key-prohibited", `Compact JWS embeds prohibited JWK field: ${field}`);
    }
  }
  const keyType = stringField(jwk, "kty");
  const expectedKeyType = algorithm.startsWith("RS") || algorithm.startsWith("PS")
    ? "RSA"
    : algorithm.startsWith("ES")
      ? "EC"
      : algorithm === "EdDSA"
        ? "OKP"
        : null;
  if (!expectedKeyType || keyType !== expectedKeyType) {
    throw new CredentialImportError("jws-key-type-mismatch", "Compact JWS algorithm and JWK key type do not match");
  }
  const requiredBase64Url = (field: string): string => {
    const value = stringField(jwk, field);
    if (
      !value
      || !/^[A-Za-z0-9_-]+$/u.test(value)
      || Buffer.from(value, "base64url").toString("base64url") !== value
    ) {
      throw new CredentialImportError("jws-key-parameters-invalid", `Compact JWS JWK ${field} is missing or invalid`);
    }
    return value;
  };
  if (keyType === "RSA") {
    requiredBase64Url("n");
    requiredBase64Url("e");
  } else if (keyType === "EC") {
    if (stringField(jwk, "crv") !== "P-256") {
      throw new CredentialImportError("jws-key-parameters-invalid", "ES256 requires a P-256 JWK");
    }
    requiredBase64Url("x");
    requiredBase64Url("y");
  } else if (keyType === "OKP") {
    if (stringField(jwk, "crv") !== "Ed25519") {
      throw new CredentialImportError("jws-key-parameters-invalid", "EdDSA requires an Ed25519 JWK");
    }
    requiredBase64Url("x");
  }
  const declaredAlgorithm = stringField(jwk, "alg");
  if (declaredAlgorithm !== null && declaredAlgorithm !== algorithm) {
    throw new CredentialImportError("jws-key-algorithm-mismatch", "Compact JWS header and JWK algorithms do not match");
  }
  const use = stringField(jwk, "use");
  if (use !== null && use !== "sig") {
    throw new CredentialImportError("jws-key-use-invalid", "Compact JWS JWK is not a signature key");
  }
  const keyOperations = jwk.key_ops;
  if (keyOperations !== undefined) {
    if (
      !Array.isArray(keyOperations)
      || keyOperations.length === 0
      || keyOperations.some((item) => item !== "verify")
      || new Set(keyOperations).size !== keyOperations.length
    ) {
      throw new CredentialImportError("jws-key-operations-invalid", "Compact JWS JWK may only declare verification capability");
    }
  }
}

function assertKidSafe(keyId: string): void {
  if (/\s/u.test(keyId)) throw new CredentialImportError("jws-key-id-invalid", "Compact JWS kid contains whitespace");
  let parsed: URL;
  try {
    parsed = new URL(keyId);
  } catch {
    throw new CredentialImportError("jws-key-id-invalid", "Compact JWS kid is not an absolute URI");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "did:") {
    throw new CredentialImportError("jws-key-id-invalid", "Compact JWS kid must use HTTPS or DID");
  }
}

export function parseCompactJws(
  compactJws: string,
  allowedAlgorithms: readonly string[],
  maxJsonDepth: number
): ParsedCompactJws {
  const segments = compactJws.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new CredentialImportError("jws-compact-format-invalid", "Compact JWS must contain three non-empty segments");
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const header = decodeJsonSegment(headerSegment, "header", maxJsonDepth);
  const payload = decodeJsonSegment(payloadSegment, "payload", maxJsonDepth);
  for (const field of Object.keys(header)) {
    if (!ALLOWED_HEADER_FIELDS.has(field)) {
      throw new CredentialImportError("jws-header-field-prohibited", `Compact JWS header field is prohibited: ${field}`);
    }
  }
  const algorithm = stringField(header, "alg");
  if (!algorithm || algorithm === "none" || algorithm.startsWith("HS") || !allowedAlgorithms.includes(algorithm)) {
    throw new CredentialImportError("jws-algorithm-prohibited", "Compact JWS algorithm is not allowed");
  }
  const type = stringField(header, "typ");
  if (type !== null && type !== "JWT") {
    throw new CredentialImportError("jws-type-invalid", "Compact JWS typ must be JWT when present");
  }
  const keyId = stringField(header, "kid");
  const jwkValue = header.jwk;
  const jwk = isJsonObject(jwkValue) ? jwkValue : null;
  if (keyId === null && jwk === null) {
    throw new CredentialImportError("jws-key-reference-invalid", "Compact JWS must contain kid, jwk, or both");
  }
  if (keyId !== null) assertKidSafe(keyId);
  if (jwk !== null) assertJwkSafe(jwk, algorithm);
  if (keyId !== null && jwk !== null && stringField(jwk, "kid") !== keyId) {
    throw new CredentialImportError(
      "jws-key-reference-conflict",
      "Compact JWS kid and embedded JWK kid must match when both are present"
    );
  }

  const vc = payload.vc;
  const credential = isJsonObject(vc) ? vc : payload;
  assertJwtBindings(payload, credential);
  return {
    compactJws,
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature: decodeBase64Url(signatureSegment, "signature"),
    algorithm,
    keyId,
    header,
    payload,
    credential
  };
}
