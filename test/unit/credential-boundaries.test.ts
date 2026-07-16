import { describe, expect, it, vi } from "vitest";
import {
  OPEN_BADGES_CONTEXT_URL,
  VC_CONTEXT_URL,
  addCredentialMapping,
  approveCredentialClaimMapping,
  assertCredentialContract,
  collectCredentialDocumentUrls,
  createCredentialClaimMapping,
  createSafeCredentialDocumentLoader,
  extractCredentialEnvelope,
  importCredential,
  parseCompactJws,
  parseJsonObjectStrict,
  validateCredentialSchemaFiles,
  type CredentialDocumentLoader,
  type CredentialImportDependencies,
  type JsonObject
} from "../../src/credentials/index.js";
import { sha256 } from "../../src/hash.js";

const NOW = new Date("2026-07-14T12:30:00.000Z");
const ISSUER = "https://issuer.example/profile";
const SUBJECT = "did:example:subject";
const CREDENTIAL = "https://issuer.example/credential/1";
const KEY = "https://issuer.example/key/1";

function credential(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL],
    id: CREDENTIAL,
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: { id: ISSUER, type: ["Profile"], name: "Issuer" },
    validFrom: "2026-07-14T10:00:00.000Z",
    validUntil: "2027-07-14T10:00:00.000Z",
    credentialSubject: {
      id: SUBJECT,
      type: ["AchievementSubject"],
      achievement: {
        id: "https://issuer.example/achievement/1",
        type: ["Achievement"],
        name: "Assurance",
        criteria: { narrative: "Pass the assessment." }
      }
    },
    proof: {
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-rdfc-2022",
      proofPurpose: "assertionMethod",
      verificationMethod: KEY,
      proofValue: "zProof"
    },
    ...overrides
  };
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jws(header: JsonObject, payloadOverrides: Partial<JsonObject> = {}): string {
  const payload: JsonObject = {
    iss: ISSUER,
    sub: SUBJECT,
    jti: CREDENTIAL,
    nbf: Date.parse("2026-07-14T10:00:00.000Z") / 1000,
    exp: Date.parse("2027-07-14T10:00:00.000Z") / 1000,
    vc: credential(),
    ...payloadOverrides
  };
  return `${encoded(header)}.${encoded(payload)}.${Buffer.from([1, 2, 3]).toString("base64url")}`;
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function verifiedDependencies(): CredentialImportDependencies {
  return {
    schemaVerifier: {
      async validate() {
        return { valid: true, reasons: [] };
      }
    },
    cryptoVerifier: {
      async verifyCompactJws(request) {
        return {
          valid: true,
          algorithm: request.algorithm,
          signerId: ISSUER,
          keyId: request.keyId,
          reasons: []
        };
      },
      async verifyDataIntegrity(request) {
        return {
          valid: true,
          algorithm: String(request.proofs[0]?.cryptosuite),
          signerId: ISSUER,
          keyId: KEY,
          reasons: []
        };
      }
    }
  };
}

describe("Credential boundary hardening", () => {
  it("rejects ambiguous JSON syntax, prohibited keys, excessive depth, and non-object roots", () => {
    const cases: Array<[string, number, string]> = [
      ['{"a":1} trailing', 4, "json-trailing-content"],
      ['{"a" 1}', 4, "json-colon-missing"],
      ['{"a":1 "b":2}', 4, "json-object-separator-invalid"],
      ['{"a":[1 2]}', 4, "json-array-separator-invalid"],
      ['{"a":"\\q"}', 4, "json-string-invalid"],
      ['{"__proto__":1}', 4, "json-key-prohibited"],
      ['{"a":{"b":{"c":1}}}', 1, "json-depth-exceeded"],
      ["[]", 4, "json-root-invalid"]
    ];
    for (const [source, depth, code] of cases) {
      expectCode(() => parseJsonObjectStrict(source, depth), code);
    }
  });

  it("rejects empty, malformed, mismatched, and unbounded source envelopes", () => {
    const limits = { maxInputBytes: 1024, maxEmbeddedCredentialBytes: 512, maxJsonDepth: 8 };
    expectCode(() => extractCredentialEnvelope({ content: "" }, limits), "credential-input-empty");
    expectCode(
      () => extractCredentialEnvelope({ content: "not-a-credential" }, limits),
      "credential-format-unsupported"
    );
    expectCode(
      () => extractCredentialEnvelope({ content: Uint8Array.from([0xff]) }, limits),
      "credential-utf8-invalid"
    );
    expectCode(
      () => extractCredentialEnvelope({ content: "{}", format: "compact-jws" }, limits),
      "credential-format-mismatch"
    );
    expectCode(
      () => extractCredentialEnvelope({ content: "{}" }, { ...limits, maxInputBytes: 0 }),
      "credential-limit-invalid"
    );
    expectCode(
      () => extractCredentialEnvelope({ content: "{}", mediaType: "\u0000invalid" }, limits),
      "credential-media-type-invalid"
    );
  });

  it("enforces exact URL allowlists, public HTTPS, response bounds, and redirect refusal", async () => {
    const urls = collectCredentialDocumentUrls(
      credential({
        credentialSchema: [{ id: "https://issuer.example/schema", type: "Schema" }],
        credentialStatus: {
          id: "https://issuer.example/status/1",
          statusListCredential: "https://issuer.example/status/list"
        },
        refreshService: { id: "https://issuer.example/refresh", type: "Refresh" }
      }),
      KEY,
      [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL],
      ["https://issuer.example/explicit"]
    );
    expect(urls).toEqual(expect.objectContaining({ size: expect.any(Number) }));
    expect(urls.has("https://issuer.example/status/list")).toBe(true);
    expect(urls.has("https://issuer.example/refresh")).toBe(true);

    const delegateLoad = vi.fn(async (request: { url: string }) => ({
      url: request.url,
      mediaType: "APPLICATION/JSON",
      bytes: Uint8Array.from([1, 2, 3])
    }));
    const safe = createSafeCredentialDocumentLoader(
      { load: delegateLoad } as CredentialDocumentLoader,
      new Set(["https://issuer.example/explicit"]),
      16
    );
    const loaded = await safe.load({
      url: "https://issuer.example/explicit",
      purpose: "schema",
      maxBytes: 64
    });
    expect(loaded).toMatchObject({ mediaType: "application/json" });
    expect(delegateLoad).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 16 }));

    await expect(safe.load({
      url: "https://issuer.example/not-allowed",
      purpose: "schema",
      maxBytes: 16
    })).rejects.toMatchObject({ code: "document-url-not-allowlisted" });

    const local = createSafeCredentialDocumentLoader(
      { load: delegateLoad } as CredentialDocumentLoader,
      new Set(["https://127.0.0.1/schema"]),
      16
    );
    await expect(local.load({
      url: "https://127.0.0.1/schema",
      purpose: "schema",
      maxBytes: 16
    })).rejects.toMatchObject({ code: "document-url-private-network" });

    const missing = createSafeCredentialDocumentLoader(
      undefined,
      new Set(["https://issuer.example/explicit"]),
      16
    );
    await expect(missing.load({
      url: "https://issuer.example/explicit",
      purpose: "schema",
      maxBytes: 16
    })).rejects.toMatchObject({ code: "document-loader-unavailable" });

    const redirected = createSafeCredentialDocumentLoader(
      {
        async load() {
          return { url: "https://issuer.example/other", mediaType: "application/json", bytes: new Uint8Array() };
        }
      },
      new Set(["https://issuer.example/explicit"]),
      16
    );
    await expect(redirected.load({
      url: "https://issuer.example/explicit",
      purpose: "schema",
      maxBytes: 16
    })).rejects.toMatchObject({ code: "document-redirect-prohibited" });

    const oversized = createSafeCredentialDocumentLoader(
      {
        async load(request) {
          return { url: request.url, mediaType: "application/json", bytes: new Uint8Array(17) };
        }
      },
      new Set(["https://issuer.example/explicit"]),
      16
    );
    await expect(oversized.load({
      url: "https://issuer.example/explicit",
      purpose: "schema",
      maxBytes: 16
    })).rejects.toMatchObject({ code: "document-too-large" });
  });

  it("rejects conflicting JOSE key material and JWT identity or time bindings", () => {
    const baseHeader: JsonObject = {
      alg: "RS256",
      typ: "JWT",
      jwk: { kty: "RSA", n: "AQAB", e: "AQAB" }
    };
    const parsed = parseCompactJws(jws(baseHeader), ["RS256"], 16);
    expect(parsed.algorithm).toBe("RS256");

    const both: JsonObject = {
      alg: "RS256",
      kid: KEY,
      jwk: { kty: "RSA", n: "AQAB", e: "AQAB", kid: KEY }
    };
    expect(parseCompactJws(jws(both), ["RS256"], 16).keyId).toBe(KEY);

    const headerCases: Array<[JsonObject, string]> = [
      [{ ...baseHeader, jku: "https://attacker.example/jwks" }, "jws-header-field-prohibited"],
      [{ ...baseHeader, typ: "JWS" }, "jws-type-invalid"],
      [{ alg: "RS256" }, "jws-key-reference-invalid"],
      [{ ...baseHeader, jwk: { kty: "RSA", n: "AQAB", e: "AQAB", d: "private" } }, "jws-private-key-prohibited"],
      [{ ...baseHeader, jwk: { kty: "EC", x: "x", y: "y" } }, "jws-key-type-mismatch"],
      [{ ...baseHeader, jwk: { kty: "RSA", n: "AQAB", e: "AQAB", alg: "PS256" } }, "jws-key-algorithm-mismatch"],
      [{ ...baseHeader, jwk: { kty: "RSA", n: "AQAB", e: "AQAB", use: "enc" } }, "jws-key-use-invalid"],
      [{ ...baseHeader, jwk: { kty: "RSA", n: "AQAB", e: "AQAB", key_ops: ["sign"] } }, "jws-key-operations-invalid"],
      [{ ...both, jwk: { kty: "RSA", n: "AQAB", e: "AQAB", kid: "https://issuer.example/key/2" } }, "jws-key-reference-conflict"]
    ];
    for (const [header, code] of headerCases) expectCode(() => parseCompactJws(jws(header), ["RS256"], 16), code);

    const payloadCases: Array<[Partial<JsonObject>, string]> = [
      [{ iss: "https://attacker.example/issuer" }, "jws-issuer-binding-mismatch"],
      [{ sub: "did:example:other" }, "jws-subject-binding-mismatch"],
      [{ jti: "https://issuer.example/other" }, "jws-id-binding-mismatch"],
      [{ nbf: 1 }, "jws-time-binding-mismatch"],
      [{ exp: 1 }, "jws-time-binding-mismatch"]
    ];
    for (const [payload, code] of payloadCases) {
      expectCode(() => parseCompactJws(jws(baseHeader, payload), ["RS256"], 16), code);
    }
  });

  it("revalidates mapping content and approval scope at every transition", async () => {
    const { entry } = await importCredential(
      { content: JSON.stringify(credential()), format: "json-ld" },
      verifiedDependencies(),
      { now: NOW, expectedSubjectId: SUBJECT }
    );
    expect(() => createCredentialClaimMapping(entry, {
      mappingId: "__proto__",
      claimType: "credential",
      claimText: "Valid text"
    })).toThrow("id is invalid");
    expect(() => createCredentialClaimMapping(entry, {
      mappingId: "MAPPING-EMPTY",
      claimType: "credential",
      claimText: ""
    })).toThrow("text is invalid");
    expect(() => createCredentialClaimMapping(entry, {
      mappingId: "MAPPING-AUTO",
      claimType: "credential",
      claimText: "Valid text",
      requestedAutoApply: true
    })).toThrow("without public disclosure");

    const mapping = createCredentialClaimMapping(entry, {
      mappingId: "MAPPING-VALID",
      claimType: "credential",
      claimText: "Earned the Assurance credential.",
      requestedPublic: true
    });
    const approval = {
      approvalId: "APPROVAL-MAPPING-VALID",
      approverPrincipalId: "HUMAN-MAPPER",
      approvedAt: "2026-07-14T12:00:00.000Z",
      expiresAt: "2026-07-14T13:00:00.000Z",
      mappingHash: mapping.mappingHash,
      allowPublic: true,
      allowAutoApply: false,
      signatureReceiptHash: sha256("approval")
    } as const;
    expect(() => approveCredentialClaimMapping(
      entry,
      mapping,
      { ...approval, expiresAt: "2026-07-14T12:01:00.000Z" },
      NOW
    )).toThrow("not currently valid");
    const approved = approveCredentialClaimMapping(entry, mapping, approval, NOW);
    expect(() => addCredentialMapping(entry, { ...approved, claimText: "Tampered text" })).toThrow(
      "mapping hash is invalid"
    );
  });

  it("compiles credential contracts and rejects malformed contract values", () => {
    expect(validateCredentialSchemaFiles()).toEqual({ valid: true, errors: [] });
    expect(() => assertCredentialContract("credential-passport", {})).toThrow("validation failed");
  });
});
