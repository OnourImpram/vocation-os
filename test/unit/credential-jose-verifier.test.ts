import {
  CompactSign,
  exportJWK,
  generateKeyPair,
  type CompactJWSHeaderParameters,
  type JWK
} from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  OPEN_BADGES_CONTEXT_URL,
  VC_CONTEXT_URL,
  createJoseCredentialCryptoVerifier,
  importCredential,
  type CompactJwsVerificationRequest,
  type CredentialDocumentLoader,
  type JsonObject
} from "../../src/credentials/index.js";

const ISSUER_ID = "https://issuer.example/profiles/1";
const SUBJECT_ID = "did:example:holder-1";
const CREDENTIAL_ID = "https://issuer.example/credentials/1";
const KEY_ID = `${ISSUER_ID}#key-1`;
const NOW = new Date("2026-07-14T12:30:00.000Z");
type SupportedAlgorithm = "RS256" | "PS256" | "ES256" | "EdDSA";

function credential(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL],
    id: CREDENTIAL_ID,
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: { id: ISSUER_ID, type: ["Profile"], name: "Issuer University" },
    validFrom: "2026-07-14T10:00:00.000Z",
    validUntil: "2027-07-14T10:00:00.000Z",
    credentialSubject: {
      id: SUBJECT_ID,
      type: ["AchievementSubject"],
      achievement: {
        id: "https://issuer.example/achievements/assurance",
        type: ["Achievement"],
        name: "Career Assurance",
        criteria: { narrative: "Completed the assessed assurance criteria." }
      }
    },
    ...overrides
  };
}

function payload(vc: JsonObject): JsonObject {
  return {
    iss: ISSUER_ID,
    sub: SUBJECT_ID,
    jti: CREDENTIAL_ID,
    nbf: Date.parse("2026-07-14T10:00:00.000Z") / 1000,
    exp: Date.parse("2027-07-14T10:00:00.000Z") / 1000,
    vc
  };
}

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function requestFromCompact(compactJws: string, vc: JsonObject): CompactJwsVerificationRequest {
  const segments = compactJws.split(".");
  if (segments.length !== 3) throw new Error("invalid test fixture");
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  return {
    compactJws,
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature: Uint8Array.from(Buffer.from(signatureSegment, "base64url")),
    algorithm: String((JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as object & { alg: string }).alg),
    keyId: (JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as object & { kid?: string }).kid ?? null,
    header: JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as JsonObject,
    payload: JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as JsonObject,
    credential: vc
  };
}

async function jwsFixture(options: {
  algorithm?: SupportedAlgorithm;
  embedded?: boolean;
  keyId?: string;
  includePrivateKey?: boolean;
  vc?: JsonObject;
} = {}): Promise<{ compactJws: string; publicJwk: JsonObject; request: CompactJwsVerificationRequest }> {
  const vc = options.vc ?? credential();
  const keyId = options.keyId ?? KEY_ID;
  const algorithm = options.algorithm ?? "RS256";
  const { privateKey, publicKey } = algorithm === "RS256" || algorithm === "PS256"
    ? await generateKeyPair(algorithm, { extractable: true, modulusLength: 2048 })
    : await generateKeyPair(algorithm, { extractable: true });
  const exportedPublic = await exportJWK(publicKey);
  const publicJwk = asJsonObject({
    ...exportedPublic,
    kid: keyId,
    alg: algorithm,
    use: "sig",
    key_ops: ["verify"]
  });
  const embeddedJwk = options.includePrivateKey
    ? asJsonObject({ ...publicJwk, ...(await exportJWK(privateKey)) })
    : publicJwk;
  const header: CompactJWSHeaderParameters = {
    alg: algorithm,
    typ: "JWT",
    kid: keyId,
    ...(options.embedded === false ? {} : { jwk: embeddedJwk as JWK })
  };
  const compactJws = await new CompactSign(Buffer.from(JSON.stringify(payload(vc)), "utf8"))
    .setProtectedHeader(header)
    .sign(privateKey);
  return { compactJws, publicJwk, request: requestFromCompact(compactJws, vc) };
}

function unavailableLoader(): CredentialDocumentLoader {
  return {
    async load() {
      throw new Error("network must not be used");
    }
  };
}

describe("JoseCredentialCryptoVerifier", () => {
  it("cryptographically verifies an issuer-bound embedded public JWK", async () => {
    const fixture = await jwsFixture();
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyCompactJws(fixture.request, unavailableLoader());

    expect(result).toEqual({
      valid: true,
      algorithm: "RS256",
      signerId: ISSUER_ID,
      keyId: KEY_ID,
      reasons: []
    });
  });

  it.each(["RS256", "PS256", "ES256", "EdDSA"] as const)(
    "verifies the exact allowlisted %s algorithm with a real asymmetric key",
    async (algorithm) => {
      const fixture = await jwsFixture({ algorithm });
      const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: [algorithm] });

      const result = await verifier.verifyCompactJws(fixture.request, unavailableLoader());

      expect(result).toMatchObject({
        valid: true,
        algorithm,
        signerId: ISSUER_ID,
        keyId: KEY_ID,
        reasons: []
      });
    }
  );

  it("integrates with Credential Passport without replacing independent schema checks", async () => {
    const fixture = await jwsFixture();
    const result = await importCredential(
      { content: fixture.compactJws, format: "compact-jws" },
      {
        cryptoVerifier: createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] }),
        schemaVerifier: { async validate() { return { valid: true, reasons: [] }; } }
      },
      { now: NOW, expectedSubjectId: SUBJECT_ID, allowedAlgorithms: ["RS256"] }
    );

    expect(result.entry.verification).toMatchObject({
      schema: { status: "pass" },
      signature: { status: "pass", code: "signature-valid" },
      issuer: { status: "pass", code: "issuer-verified" },
      subject: { status: "pass" },
      time: { status: "pass" },
      overall: "verified",
      eligibleForMapping: true
    });
  });

  it("resolves only the signed key id through the governed document loader", async () => {
    const resolvedKeyId = `${ISSUER_ID}/keys/2`;
    const fixture = await jwsFixture({ embedded: false, keyId: resolvedKeyId });
    const load = vi.fn<CredentialDocumentLoader["load"]>(async (request) => ({
      url: request.url,
      mediaType: "application/did+ld+json",
      bytes: Buffer.from(JSON.stringify({
        id: ISSUER_ID,
        verificationMethod: [{
          id: resolvedKeyId,
          controller: ISSUER_ID,
          publicKeyJwk: fixture.publicJwk
        }],
        assertionMethod: [resolvedKeyId]
      }), "utf8")
    }));
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyCompactJws(fixture.request, { load });

    expect(result.valid).toBe(true);
    expect(result.keyId).toBe(resolvedKeyId);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith({
      url: resolvedKeyId,
      purpose: "verification-method",
      maxBytes: 65_536
    });
  });

  it("supports exact wrapper and JWK Set key selection without remote key indirection", async () => {
    const directKeyId = `${ISSUER_ID}/keys/direct`;
    const directFixture = await jwsFixture({ embedded: false, keyId: directKeyId });
    const wrapperKeyId = `${ISSUER_ID}/keys/wrapper`;
    const wrapperFixture = await jwsFixture({ embedded: false, keyId: wrapperKeyId });
    const setKeyId = `${ISSUER_ID}/keys/set`;
    const setFixture = await jwsFixture({ embedded: false, keyId: setKeyId });
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const directResult = await verifier.verifyCompactJws(directFixture.request, {
      async load(request) {
        return {
          url: request.url,
          mediaType: "application/jwk+json",
          bytes: Buffer.from(JSON.stringify(directFixture.publicJwk), "utf8")
        };
      }
    });
    const wrapperResult = await verifier.verifyCompactJws(wrapperFixture.request, {
      async load(request) {
        return {
          url: request.url,
          mediaType: "application/json",
          bytes: Buffer.from(JSON.stringify({
            id: wrapperKeyId,
            controller: ISSUER_ID,
            publicKeyJwk: wrapperFixture.publicJwk
          }), "utf8")
        };
      }
    });
    const setResult = await verifier.verifyCompactJws(setFixture.request, {
      async load(request) {
        return {
          url: request.url,
          mediaType: "application/jwk-set+json",
          bytes: Buffer.from(JSON.stringify({ keys: [setFixture.publicJwk] }), "utf8")
        };
      }
    });

    expect(directResult.valid).toBe(true);
    expect(wrapperResult.valid).toBe(true);
    expect(setResult.valid).toBe(true);
  });

  it("requires DID-style verification methods to be authorized for assertions", async () => {
    const keyId = `${ISSUER_ID}/keys/not-authorized`;
    const fixture = await jwsFixture({ embedded: false, keyId });
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyCompactJws(fixture.request, {
      async load(request) {
        return {
          url: request.url,
          mediaType: "application/did+ld+json",
          bytes: Buffer.from(JSON.stringify({
            id: ISSUER_ID,
            verificationMethod: [{
              id: keyId,
              controller: ISSUER_ID,
              publicKeyJwk: fixture.publicJwk
            }]
          }), "utf8")
        };
      }
    });

    expect(result).toMatchObject({
      valid: false,
      reasons: ["jws-key-not-authorized-for-assertion"]
    });
  });

  it("rejects malformed, mistyped, and issuer-mismatched key documents", async () => {
    const keyId = `${ISSUER_ID}/keys/rejected-documents`;
    const fixture = await jwsFixture({ embedded: false, keyId });
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });
    const loaderFor = (mediaType: string, body: string): CredentialDocumentLoader => ({
      async load(request) {
        return { url: request.url, mediaType, bytes: Buffer.from(body, "utf8") };
      }
    });

    await expect(verifier.verifyCompactJws(
      fixture.request,
      loaderFor("application/json", "{")
    )).resolves.toMatchObject({ valid: false, reasons: ["jws-key-document-invalid"] });
    await expect(verifier.verifyCompactJws(
      fixture.request,
      loaderFor("text/plain", JSON.stringify(fixture.publicJwk))
    )).resolves.toMatchObject({ valid: false, reasons: ["jws-key-document-media-type-invalid"] });
    await expect(verifier.verifyCompactJws(
      fixture.request,
      loaderFor("application/json", JSON.stringify({
        id: keyId,
        controller: "https://issuer.example/profiles/another",
        publicKeyJwk: fixture.publicJwk
      }))
    )).resolves.toMatchObject({ valid: false, reasons: ["jws-key-issuer-mismatch"] });
  });

  it("rejects an unanchored key id before any loader access", async () => {
    const fixture = await jwsFixture({ embedded: false, keyId: "https://attacker.example/key-1" });
    const load = vi.fn<CredentialDocumentLoader["load"]>();
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyCompactJws(fixture.request, { load });

    expect(result).toMatchObject({ valid: false, reasons: ["jws-key-issuer-mismatch"] });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects normalized path traversal in a seemingly issuer-prefixed key id", async () => {
    const fixture = await jwsFixture({
      embedded: false,
      keyId: `${ISSUER_ID}/../../attacker-key`
    });
    const load = vi.fn<CredentialDocumentLoader["load"]>();
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyCompactJws(fixture.request, { load });

    expect(result).toMatchObject({ valid: false, reasons: ["jws-key-issuer-mismatch"] });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects cryptographic tampering even when request objects match the tampered payload", async () => {
    const fixture = await jwsFixture();
    const segments = fixture.compactJws.split(".") as [string, string, string];
    const tamperedCredential = credential({
      credentialSubject: {
        id: SUBJECT_ID,
        type: ["AchievementSubject"],
        achievement: {
          id: "https://issuer.example/achievements/assurance",
          type: ["Achievement"],
          name: "Inflated unverified credential",
          criteria: { narrative: "Changed after signing." }
        }
      }
    });
    const tamperedPayload = Buffer.from(JSON.stringify(payload(tamperedCredential)), "utf8").toString("base64url");
    const tamperedCompact = `${segments[0]}.${tamperedPayload}.${segments[2]}`;
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyCompactJws(
      requestFromCompact(tamperedCompact, tamperedCredential),
      unavailableLoader()
    );

    expect(result).toMatchObject({
      valid: false,
      reasons: ["jws-cryptographic-verification-failed"]
    });
  });

  it("rejects algorithm policy mismatch before key resolution", async () => {
    const fixture = await jwsFixture({ embedded: false });
    const load = vi.fn<CredentialDocumentLoader["load"]>();
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["ES256"] });

    const result = await verifier.verifyCompactJws(fixture.request, { load });

    expect(result).toMatchObject({ valid: false, reasons: ["jws-algorithm-prohibited"] });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects embedded private key material before jose imports the key", async () => {
    const fixture = await jwsFixture({ includePrivateKey: true });
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyCompactJws(fixture.request, unavailableLoader());

    expect(result).toMatchObject({ valid: false, reasons: ["jws-private-key-prohibited"] });
  });

  it("rejects detached request payload and signing-input substitutions", async () => {
    const fixture = await jwsFixture();
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });
    const changedPayload: CompactJwsVerificationRequest = {
      ...fixture.request,
      payload: { ...fixture.request.payload, aud: "unexpected-audience" }
    };
    const changedSigningInput: CompactJwsVerificationRequest = {
      ...fixture.request,
      signingInput: `${fixture.request.signingInput}x`
    };

    await expect(verifier.verifyCompactJws(changedPayload, unavailableLoader())).resolves.toMatchObject({
      valid: false,
      reasons: ["jws-payload-binding-mismatch"]
    });
    await expect(verifier.verifyCompactJws(changedSigningInput, unavailableLoader())).resolves.toMatchObject({
      valid: false,
      reasons: ["jws-signing-input-mismatch"]
    });
  });

  it("keeps Data Integrity explicitly unsupported and fail closed", async () => {
    const verifier = createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] });

    const result = await verifier.verifyDataIntegrity(
      {
        credential: credential(),
        proofs: [{ cryptosuite: "eddsa-rdfc-2022" }],
        allowedCryptosuites: ["eddsa-rdfc-2022"]
      },
      unavailableLoader()
    );

    expect(result).toEqual({
      valid: false,
      algorithm: "eddsa-rdfc-2022",
      signerId: null,
      keyId: null,
      reasons: ["data-integrity-verification-unsupported"]
    });
  });

  it("rejects invalid verifier policy configuration", () => {
    expect(() => createJoseCredentialCryptoVerifier({ allowedAlgorithms: [] })).toThrow(TypeError);
    expect(() => createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["RS256", "RS256"] })).toThrow(TypeError);
    expect(() => createJoseCredentialCryptoVerifier({ allowedAlgorithms: ["HS256"] })).toThrow(TypeError);
    expect(() => createJoseCredentialCryptoVerifier({
      allowedAlgorithms: ["RS256"],
      maxKeyDocumentBytes: 512
    })).toThrow(TypeError);
  });
});
