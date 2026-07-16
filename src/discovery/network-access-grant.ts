import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyLike
} from "node:crypto";
import { sha256, stableStringify } from "../hash.js";
import {
  GOVERNED_HTTP_METHODS,
  isValidHostPattern,
  validateNetworkAccessGrant,
  type GovernedHttpMethod,
  type NetworkAccessGrant,
  type NetworkAccessGrantVerificationContext,
  type NetworkAccessGrantVerifier
} from "./governance.js";

export const NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM = "Ed25519" as const;
export const NETWORK_ACCESS_GRANT_SIGNING_CONTEXT = "vocation-os/network-access-grant/v1" as const;

const GRANT_KEYS = [
  "grantId",
  "subject",
  "purpose",
  "providerId",
  "manifestId",
  "manifestVersion",
  "issuedAt",
  "expiresAt",
  "allowedHosts",
  "allowedMethods",
  "requestBudget"
] as const;
const ENVELOPE_KEYS = [
  "grant",
  "approvedBy",
  "keyId",
  "signatureAlgorithm",
  "grantDigest",
  "signature"
] as const;
const APPROVED_BY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_ID_PATTERN = /^KEY-[A-Za-z0-9-]{8,100}$/;
const GRANT_ID_PATTERN = /^NAG-[A-Z0-9][A-Z0-9-]{7,127}$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const MANIFEST_ID_PATTERN = /^egress:[a-z][a-z0-9-]{1,63}$/;
const MANIFEST_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_TRUSTED_ISSUERS = 1_024;
const MAX_REASONS = 8;

export interface SignedNetworkAccessGrantEnvelope {
  readonly grant: NetworkAccessGrant;
  readonly approvedBy: string;
  readonly keyId: string;
  readonly signatureAlgorithm: typeof NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM;
  readonly grantDigest: string;
  readonly signature: string;
}

export interface NetworkAccessGrantSigner {
  readonly approvedBy: string;
  readonly keyId: string;
  readonly privateKey: KeyLike;
}

export interface TrustedNetworkAccessGrantIssuer {
  readonly approvedBy: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface NetworkAccessGrantSigningBinding {
  readonly approvedBy: string;
  readonly keyId: string;
  readonly signatureAlgorithm: typeof NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM;
}

export type SignedNetworkAccessGrantVerificationReason =
  | "envelope-invalid"
  | "algorithm-not-allowed"
  | "grant-digest-invalid"
  | "grant-digest-mismatch"
  | "issuer-not-trusted"
  | "trust-registry-invalid"
  | "trusted-key-invalid"
  | "signature-encoding-invalid"
  | "signature-invalid"
  | "verification-time-invalid"
  | "manifest-invalid"
  | "provider-manifest-mismatch"
  | "grant-not-active"
  | "grant-expired"
  | "grant-window-invalid"
  | "host-scope-invalid"
  | "method-scope-invalid"
  | "request-budget-invalid"
  | "grant-invalid"
  | "grant-mismatch"
  | "verification-aborted"
  | "verification-unavailable";

export type SignedNetworkAccessGrantVerificationResult =
  | {
      readonly verified: true;
      readonly reasons: readonly [];
      readonly grant: NetworkAccessGrant;
      readonly grantDigest: string;
      readonly approvedBy: string;
      readonly keyId: string;
    }
  | {
      readonly verified: false;
      readonly reason: SignedNetworkAccessGrantVerificationReason;
      readonly reasons: readonly SignedNetworkAccessGrantVerificationReason[];
    };

export interface SignedNetworkAccessGrantVerificationOptions extends NetworkAccessGrantVerificationContext {
  readonly trustedIssuers: readonly TrustedNetworkAccessGrantIssuer[];
}

type MaybePromise<T> = T | Promise<T>;

export interface SignedNetworkAccessGrantVerifierOptions {
  readonly resolveEnvelope: (
    grant: NetworkAccessGrant,
    context: NetworkAccessGrantVerificationContext,
    signal: AbortSignal
  ) => MaybePromise<unknown>;
  readonly trustedIssuers:
    | readonly TrustedNetworkAccessGrantIssuer[]
    | ((
        context: NetworkAccessGrantVerificationContext,
        signal: AbortSignal
      ) => MaybePromise<readonly TrustedNetworkAccessGrantIssuer[]>);
}

interface ParsedEnvelope {
  readonly grant: NetworkAccessGrant;
  readonly approvedBy: string;
  readonly keyId: string;
  readonly signatureAlgorithm: string;
  readonly grantDigest: string;
  readonly signature: string;
}

function hasExactDataKeys(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== "string")) return false;
    const expected = new Set(expectedKeys);
    for (const key of ownKeys) {
      if (typeof key !== "string" || !expected.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isStrictArray(value: unknown, minimum: number, maximum: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) return false;
    if (Object.keys(value).length !== value.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    }
    return ownKeys.every((key) => key === "length" || /^\d+$/.test(key as string));
  } catch {
    return false;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function parseGrant(value: unknown): NetworkAccessGrant | null {
  if (!hasExactDataKeys(value, GRANT_KEYS)) return null;
  const grantId = value["grantId"];
  const subject = value["subject"];
  const purpose = value["purpose"];
  const providerId = value["providerId"];
  const manifestId = value["manifestId"];
  const manifestVersion = value["manifestVersion"];
  const issuedAt = value["issuedAt"];
  const expiresAt = value["expiresAt"];
  const allowedHosts = value["allowedHosts"];
  const allowedMethods = value["allowedMethods"];
  const requestBudget = value["requestBudget"];

  if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) return null;
  if (!isBoundedText(subject, 160) || !isBoundedText(purpose, 512)) return null;
  if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) return null;
  if (typeof manifestId !== "string" || !MANIFEST_ID_PATTERN.test(manifestId)) return null;
  if (typeof manifestVersion !== "string" || !MANIFEST_VERSION_PATTERN.test(manifestVersion)) return null;
  if (!isCanonicalTimestamp(issuedAt) || !isCanonicalTimestamp(expiresAt)) return null;
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) return null;
  if (!isStrictArray(allowedHosts, 1, 128)) return null;
  if (
    allowedHosts.some((host) => typeof host !== "string" || !isValidHostPattern(host))
    || new Set(allowedHosts).size !== allowedHosts.length
  ) return null;
  if (!isStrictArray(allowedMethods, 1, 2)) return null;
  if (
    allowedMethods.some(
      (method) => typeof method !== "string" || !(GOVERNED_HTTP_METHODS as readonly string[]).includes(method)
    )
    || new Set(allowedMethods).size !== allowedMethods.length
  ) return null;
  if (!Number.isSafeInteger(requestBudget) || (requestBudget as number) < 1 || (requestBudget as number) > 1_000_000) {
    return null;
  }

  return {
    grantId,
    subject,
    purpose,
    providerId,
    manifestId,
    manifestVersion,
    issuedAt,
    expiresAt,
    allowedHosts: [...allowedHosts] as string[],
    allowedMethods: [...allowedMethods] as GovernedHttpMethod[],
    requestBudget: requestBudget as number
  };
}

function parseEnvelope(value: unknown): ParsedEnvelope | null {
  if (!hasExactDataKeys(value, ENVELOPE_KEYS)) return null;
  const grant = parseGrant(value["grant"]);
  const approvedBy = value["approvedBy"];
  const keyId = value["keyId"];
  const signatureAlgorithm = value["signatureAlgorithm"];
  const grantDigest = value["grantDigest"];
  const signature = value["signature"];
  if (!grant) return null;
  if (typeof approvedBy !== "string" || !APPROVED_BY_PATTERN.test(approvedBy)) return null;
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) return null;
  if (typeof signatureAlgorithm !== "string" || signatureAlgorithm.length < 1 || signatureAlgorithm.length > 32) return null;
  if (typeof grantDigest !== "string" || grantDigest.length > 128) return null;
  if (typeof signature !== "string" || signature.length < 1 || signature.length > 512) return null;
  return { grant, approvedBy, keyId, signatureAlgorithm, grantDigest, signature };
}

function signingBinding(
  approvedBy: string,
  keyId: string,
  signatureAlgorithm: string
): NetworkAccessGrantSigningBinding {
  if (!APPROVED_BY_PATTERN.test(approvedBy)) throw new Error("Network access grant approver identity is invalid");
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error("Network access grant key id is invalid");
  if (signatureAlgorithm !== NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM) {
    throw new Error("Network access grants require Ed25519 signatures");
  }
  return { approvedBy, keyId, signatureAlgorithm };
}

export function canonicalNetworkAccessGrantPayload(
  grantValue: NetworkAccessGrant,
  bindingValue: NetworkAccessGrantSigningBinding
): string {
  const grant = parseGrant(grantValue);
  if (!grant) throw new Error("Network access grant must contain exactly the canonical grant fields");
  const binding = signingBinding(
    bindingValue.approvedBy,
    bindingValue.keyId,
    bindingValue.signatureAlgorithm
  );
  return stableStringify({
    context: NETWORK_ACCESS_GRANT_SIGNING_CONTEXT,
    grant,
    approvedBy: binding.approvedBy,
    keyId: binding.keyId,
    signatureAlgorithm: binding.signatureAlgorithm
  });
}

export function computeNetworkAccessGrantDigest(
  grant: NetworkAccessGrant,
  binding: NetworkAccessGrantSigningBinding
): string {
  return sha256(canonicalNetworkAccessGrantPayload(grant, binding));
}

export function createSignedNetworkAccessGrant(
  grantValue: NetworkAccessGrant,
  signer: NetworkAccessGrantSigner
): SignedNetworkAccessGrantEnvelope {
  const grant = parseGrant(grantValue);
  if (!grant) throw new Error("Network access grant must contain exactly the canonical grant fields");
  const binding = signingBinding(signer.approvedBy, signer.keyId, NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM);
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = typeof signer.privateKey === "string" || Buffer.isBuffer(signer.privateKey)
      ? createPrivateKey(signer.privateKey)
      : signer.privateKey;
  } catch {
    throw new Error("Network access grant signing key is invalid");
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Network access grant signing key must be an Ed25519 private key");
  }
  const canonicalPayload = canonicalNetworkAccessGrantPayload(grant, binding);
  return {
    grant,
    approvedBy: binding.approvedBy,
    keyId: binding.keyId,
    signatureAlgorithm: binding.signatureAlgorithm,
    grantDigest: sha256(canonicalPayload),
    signature: sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey).toString("base64url")
  };
}

function rejected(
  ...inputReasons: readonly SignedNetworkAccessGrantVerificationReason[]
): SignedNetworkAccessGrantVerificationResult {
  const reasons = [...new Set(inputReasons)].slice(0, MAX_REASONS);
  const reason = reasons[0] ?? "grant-invalid";
  return { verified: false, reason, reasons };
}

function canonicalEd25519Signature(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength !== ED25519_SIGNATURE_BYTES || decoded.toString("base64url") !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function matchingTrustedIssuer(
  trustedIssuers: readonly TrustedNetworkAccessGrantIssuer[],
  approvedBy: string,
  keyId: string
): TrustedNetworkAccessGrantIssuer | SignedNetworkAccessGrantVerificationReason {
  if (!Array.isArray(trustedIssuers) || trustedIssuers.length > MAX_TRUSTED_ISSUERS) {
    return "trust-registry-invalid";
  }
  const matching = trustedIssuers.filter(
    (candidate) => candidate?.approvedBy === approvedBy && candidate.keyId === keyId
  );
  if (matching.length === 0) return "issuer-not-trusted";
  if (matching.length !== 1) return "trust-registry-invalid";
  const issuer = matching[0];
  if (
    !issuer
    || !APPROVED_BY_PATTERN.test(issuer.approvedBy)
    || !KEY_ID_PATTERN.test(issuer.keyId)
    || typeof issuer.publicKeyPem !== "string"
    || issuer.publicKeyPem.length < 1
    || issuer.publicKeyPem.length > 8_192
    || !issuer.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")
  ) return "trust-registry-invalid";
  return issuer;
}

function governanceReasons(errors: readonly string[]): SignedNetworkAccessGrantVerificationReason[] {
  const reasons = new Set<SignedNetworkAccessGrantVerificationReason>();
  for (const error of errors) {
    if (error.startsWith("manifest:")) reasons.add("manifest-invalid");
    else if (/^(?:providerId|manifestId|manifestVersion) /.test(error)) reasons.add("provider-manifest-mismatch");
    else if (/^(?:allowedHosts|allowed host)/.test(error)) reasons.add("host-scope-invalid");
    else if (error.startsWith("allowedMethods")) reasons.add("method-scope-invalid");
    else if (error.startsWith("requestBudget")) reasons.add("request-budget-invalid");
    else if (error === "grant is not active yet") reasons.add("grant-not-active");
    else if (error === "grant has expired") reasons.add("grant-expired");
    else if (error.includes("lifetime") || error === "expiresAt must be after issuedAt") reasons.add("grant-window-invalid");
    else reasons.add("grant-invalid");
    if (reasons.size >= MAX_REASONS) break;
  }
  return [...reasons];
}

function verifySignedNetworkAccessGrantInternal(
  envelopeValue: unknown,
  options: SignedNetworkAccessGrantVerificationOptions
): SignedNetworkAccessGrantVerificationResult {
  const envelope = parseEnvelope(envelopeValue);
  if (!envelope) return rejected("envelope-invalid");
  if (envelope.signatureAlgorithm !== NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM) {
    return rejected("algorithm-not-allowed");
  }
  if (!SHA256_PATTERN.test(envelope.grantDigest)) return rejected("grant-digest-invalid");
  const signature = canonicalEd25519Signature(envelope.signature);
  if (!signature) return rejected("signature-encoding-invalid");

  const binding: NetworkAccessGrantSigningBinding = {
    approvedBy: envelope.approvedBy,
    keyId: envelope.keyId,
    signatureAlgorithm: NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM
  };
  const canonicalPayload = canonicalNetworkAccessGrantPayload(envelope.grant, binding);
  if (sha256(canonicalPayload) !== envelope.grantDigest) return rejected("grant-digest-mismatch");

  const trustedIssuer = matchingTrustedIssuer(options.trustedIssuers, envelope.approvedBy, envelope.keyId);
  if (typeof trustedIssuer === "string") return rejected(trustedIssuer);
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(trustedIssuer.publicKeyPem);
  } catch {
    return rejected("trusted-key-invalid");
  }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    return rejected("trusted-key-invalid");
  }
  try {
    if (!verify(null, Buffer.from(canonicalPayload, "utf8"), publicKey, signature)) {
      return rejected("signature-invalid");
    }
  } catch {
    return rejected("signature-invalid");
  }

  if (!isCanonicalTimestamp(options.verifiedAt)) return rejected("verification-time-invalid");
  const validation = validateNetworkAccessGrant(envelope.grant, options.manifest, new Date(options.verifiedAt));
  if (!validation.valid) return rejected(...governanceReasons(validation.errors));
  return {
    verified: true,
    reasons: [],
    grant: envelope.grant,
    grantDigest: envelope.grantDigest,
    approvedBy: envelope.approvedBy,
    keyId: envelope.keyId
  };
}

export function verifySignedNetworkAccessGrant(
  envelopeValue: unknown,
  options: SignedNetworkAccessGrantVerificationOptions
): SignedNetworkAccessGrantVerificationResult {
  try {
    return verifySignedNetworkAccessGrantInternal(envelopeValue, options);
  } catch {
    return rejected("verification-unavailable");
  }
}

export function createSignedNetworkAccessGrantVerifier(
  options: SignedNetworkAccessGrantVerifierOptions
): NetworkAccessGrantVerifier {
  return {
    async verify(grant, context, signal) {
      if (signal.aborted) return { verified: false, reason: "verification-aborted" };
      try {
        const suppliedGrant = parseGrant(grant);
        if (!suppliedGrant) return { verified: false, reason: "grant-invalid" };
        const envelope = await options.resolveEnvelope(suppliedGrant, context, signal);
        if (signal.aborted) return { verified: false, reason: "verification-aborted" };
        const trustedIssuers = typeof options.trustedIssuers === "function"
          ? await options.trustedIssuers(context, signal)
          : options.trustedIssuers;
        if (signal.aborted) return { verified: false, reason: "verification-aborted" };
        const result = verifySignedNetworkAccessGrant(envelope, { ...context, trustedIssuers });
        if (!result.verified) return { verified: false, reason: result.reasons.join(",") };
        if (stableStringify(suppliedGrant) !== stableStringify(result.grant)) {
          return { verified: false, reason: "grant-mismatch" };
        }
        return { verified: true };
      } catch {
        return { verified: false, reason: "verification-unavailable" };
      }
    }
  };
}

export const createNetworkAccessGrantEnvelope = createSignedNetworkAccessGrant;
export const verifyNetworkAccessGrantEnvelope = verifySignedNetworkAccessGrant;
