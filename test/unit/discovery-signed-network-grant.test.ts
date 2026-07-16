import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { describe, expect, it } from "vitest";
import {
  NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM,
  canonicalNetworkAccessGrantPayload,
  computeNetworkAccessGrantDigest,
  createSignedNetworkAccessGrant,
  createSignedNetworkAccessGrantVerifier,
  verifySignedNetworkAccessGrant,
  type NetworkAccessGrantSigningBinding,
  type SignedNetworkAccessGrantEnvelope,
  type SignedNetworkAccessGrantVerificationOptions,
  type SignedNetworkAccessGrantVerificationReason,
  type TrustedNetworkAccessGrantIssuer
} from "../../src/discovery/index.js";
import type {
  EgressManifest,
  NetworkAccessGrant,
  NetworkAccessGrantVerificationContext
} from "../../src/discovery/governance.js";

const VERIFIED_AT = "2026-07-14T10:00:00.000Z";
const issuerKeyPair = generateKeyPairSync("ed25519");
const rogueKeyPair = generateKeyPairSync("ed25519");
const wrongAlgorithmKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });

const TRUSTED_ISSUER: TrustedNetworkAccessGrantIssuer = {
  approvedBy: "authority:network",
  keyId: "KEY-NETWORK-0001",
  publicKeyPem: issuerKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
};

function manifest(overrides: Partial<EgressManifest> = {}): EgressManifest {
  return {
    manifestId: "egress:test-provider",
    providerId: "test-provider",
    version: "1.0.0",
    allowedHosts: ["api.example.com", "status.example.com"],
    allowedPorts: [443],
    allowedPathPrefixes: ["/jobs"],
    allowedMethods: ["GET"],
    allowedRequestHeaders: ["accept"],
    redirectPolicy: { maxRedirects: 1, allowCrossHost: false },
    responsePolicy: {
      allowedStatusRanges: [{ min: 200, max: 299 }],
      allowedContentTypes: ["application/json"],
      requireContentType: true,
      maxBodyBytes: 1_024,
      timeoutMs: 1_000
    },
    ratePolicy: { maxRequests: 10, windowMs: 60_000 },
    cachePolicy: { ttlMs: 60_000, methods: ["GET"] },
    grantPolicy: { maxTtlMs: 3_600_000, maxRequests: 10, requireExactHosts: true },
    ...overrides
  };
}

function grant(overrides: Partial<NetworkAccessGrant> = {}): NetworkAccessGrant {
  return {
    grantId: "NAG-SIGNED-GRANT-0001",
    subject: "headless-discovery-worker",
    purpose: "retrieve provider job records",
    providerId: "test-provider",
    manifestId: "egress:test-provider",
    manifestVersion: "1.0.0",
    issuedAt: "2026-07-14T09:55:00.000Z",
    expiresAt: "2026-07-14T10:05:00.000Z",
    allowedHosts: ["api.example.com"],
    allowedMethods: ["GET"],
    requestBudget: 5,
    ...overrides
  };
}

function signGrant(
  value: NetworkAccessGrant = grant(),
  approvedBy = TRUSTED_ISSUER.approvedBy,
  keyId = TRUSTED_ISSUER.keyId,
  privateKey = issuerKeyPair.privateKey
): SignedNetworkAccessGrantEnvelope {
  return createSignedNetworkAccessGrant(value, { approvedBy, keyId, privateKey });
}

function verificationOptions(
  overrides: Partial<SignedNetworkAccessGrantVerificationOptions> = {}
): SignedNetworkAccessGrantVerificationOptions {
  return {
    manifest: manifest(),
    verifiedAt: VERIFIED_AT,
    trustedIssuers: [TRUSTED_ISSUER],
    ...overrides
  };
}

function rejectionReason(
  envelope: unknown,
  options = verificationOptions()
): SignedNetworkAccessGrantVerificationReason {
  const result = verifySignedNetworkAccessGrant(envelope, options);
  expect(result.verified).toBe(false);
  if (result.verified) throw new Error("Expected signed network access grant rejection");
  expect(result.reasons.length).toBeGreaterThan(0);
  expect(result.reasons.length).toBeLessThanOrEqual(8);
  return result.reason;
}

describe("signed NetworkAccessGrant", () => {
  it("creates a canonical domain-separated Ed25519 envelope with a stable replay digest", () => {
    const first = signGrant();
    const reordered: NetworkAccessGrant = {
      requestBudget: 5,
      allowedMethods: ["GET"],
      allowedHosts: ["api.example.com"],
      expiresAt: "2026-07-14T10:05:00.000Z",
      issuedAt: "2026-07-14T09:55:00.000Z",
      manifestVersion: "1.0.0",
      manifestId: "egress:test-provider",
      providerId: "test-provider",
      purpose: "retrieve provider job records",
      subject: "headless-discovery-worker",
      grantId: "NAG-SIGNED-GRANT-0001"
    };
    const second = signGrant(reordered);
    const binding: NetworkAccessGrantSigningBinding = {
      approvedBy: first.approvedBy,
      keyId: first.keyId,
      signatureAlgorithm: NETWORK_ACCESS_GRANT_SIGNATURE_ALGORITHM
    };

    expect(first.grantDigest).toBe(computeNetworkAccessGrantDigest(first.grant, binding));
    expect(first.grantDigest).toBe(second.grantDigest);
    expect(first.signature).toBe(second.signature);
    expect(canonicalNetworkAccessGrantPayload(first.grant, binding)).toContain(
      "vocation-os/network-access-grant/v1"
    );
    expect(verifySignedNetworkAccessGrant(first, verificationOptions())).toMatchObject({
      verified: true,
      reasons: [],
      grantDigest: first.grantDigest,
      approvedBy: TRUSTED_ISSUER.approvedBy,
      keyId: TRUSTED_ISSUER.keyId
    });
  });

  it("rejects self-asserted verification state and every non-exact envelope or grant field", () => {
    const envelope = signGrant();
    expect(rejectionReason({ ...envelope, verified: true })).toBe("envelope-invalid");
    expect(rejectionReason({
      ...envelope,
      grant: { ...envelope.grant, verified: true }
    })).toBe("envelope-invalid");
    const hostileEnvelope = new Proxy(envelope, {
      get(target, property, receiver) {
        if (property === "grant") throw new Error("hostile envelope getter");
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    expect(rejectionReason(hostileEnvelope)).toBe("verification-unavailable");
  });

  it("rejects signature tampering and detects signed-field mutation before policy evaluation", () => {
    const envelope = signGrant();
    const replacement = envelope.signature.startsWith("A") ? "B" : "A";
    expect(rejectionReason({
      ...envelope,
      signature: `${replacement}${envelope.signature.slice(1)}`
    })).toBe("signature-invalid");
    expect(rejectionReason({
      ...envelope,
      grant: { ...envelope.grant, purpose: "mutated purpose" }
    })).toBe("grant-digest-mismatch");
  });

  it("rejects expired grants after authenticating the issuer and signature", () => {
    const expired = signGrant(grant({
      issuedAt: "2026-07-14T08:00:00.000Z",
      expiresAt: "2026-07-14T09:00:00.000Z"
    }));
    expect(rejectionReason(expired)).toBe("grant-expired");
  });

  it("rejects unknown issuers and trusted records that are not Ed25519 public keys", () => {
    const unknown = signGrant(
      grant(),
      "authority:rogue",
      "KEY-ROGUE-0001",
      rogueKeyPair.privateKey
    );
    expect(rejectionReason(unknown)).toBe("issuer-not-trusted");

    const wrongAlgorithmIssuer: TrustedNetworkAccessGrantIssuer = {
      ...TRUSTED_ISSUER,
      publicKeyPem: wrongAlgorithmKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
    };
    expect(rejectionReason(signGrant(), verificationOptions({
      trustedIssuers: [wrongAlgorithmIssuer]
    }))).toBe("trusted-key-invalid");
  });

  it("rejects host, method, and request-budget scope outside the bound provider manifest", () => {
    const overbroad = signGrant(grant({
      allowedHosts: ["outside.example.com"],
      allowedMethods: ["HEAD"],
      requestBudget: 11
    }));
    const result = verifySignedNetworkAccessGrant(overbroad, verificationOptions());
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("Expected provider scope rejection");
    expect(result.reasons).toEqual([
      "host-scope-invalid",
      "method-scope-invalid",
      "request-budget-invalid"
    ]);
  });

  it("rejects provider manifest rebinding and algorithm confusion", () => {
    const rebound = signGrant(grant({ manifestVersion: "2.0.0" }));
    expect(rejectionReason(rebound)).toBe("provider-manifest-mismatch");

    const envelope = signGrant();
    expect(rejectionReason({ ...envelope, signatureAlgorithm: "EdDSA" })).toBe("algorithm-not-allowed");
  });

  it("adapts to NetworkAccessGrantVerifier without trusting a resolver-supplied near match", async () => {
    const envelope = signGrant();
    const verifier = createSignedNetworkAccessGrantVerifier({
      resolveEnvelope: async () => envelope,
      trustedIssuers: async () => [TRUSTED_ISSUER]
    });
    const context: NetworkAccessGrantVerificationContext = {
      manifest: manifest(),
      verifiedAt: VERIFIED_AT
    };
    const signal = new AbortController().signal;

    await expect(verifier.verify(grant(), context, signal)).resolves.toEqual({ verified: true });
    await expect(verifier.verify(grant({ purpose: "unsigned near match" }), context, signal)).resolves.toEqual({
      verified: false,
      reason: "grant-mismatch"
    });
    await expect(verifier.verify(
      { ...grant(), verified: true } as unknown as NetworkAccessGrant,
      context,
      signal
    )).resolves.toEqual({
      verified: false,
      reason: "grant-invalid"
    });
  });

  it("ships a standalone exact JSON schema for headless envelope transport", () => {
    const schema = JSON.parse(
      readFileSync(path.resolve("schemas", "discovery-signed-network-access-grant.schema.json"), "utf8")
    ) as AnySchema;
    const ajv = new Ajv({ allErrors: true, strict: true });
    const addFormats = (addFormatsModule as unknown as { default?: (instance: Ajv) => void }).default
      ?? (addFormatsModule as unknown as (instance: Ajv) => void);
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const envelope = signGrant();

    expect(validate(envelope)).toBe(true);
    expect(validate({ ...envelope, verified: true })).toBe(false);
  });
});
