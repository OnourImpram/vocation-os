import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../../src/hash.js";
import {
  OPEN_BADGES_CONTEXT_URL,
  VC_CONTEXT_URL,
  addCredentialMapping,
  approveCredentialClaimMapping,
  collectCredentialDocumentUrls,
  createSafeCredentialDocumentLoader,
  createCredentialClaimMapping,
  importCredential,
  validateCredentialContract,
  validateCredentialSchemaFiles,
  type CompactJwsVerificationRequest,
  type CredentialImportDependencies,
  type CredentialImportOptions,
  type CredentialImportSource,
  type CredentialMappingApproval,
  type JsonObject
} from "../../src/credentials/index.js";

const NOW = new Date("2026-07-14T12:30:00.000Z");
const ISSUER_ID = "https://issuer.example/profiles/1";
const SUBJECT_ID = "did:example:holder-1";
const CREDENTIAL_ID = "https://issuer.example/credentials/1";
const ACHIEVEMENT_ID = "https://issuer.example/achievements/assurance";

function baseCredential(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL],
    id: CREDENTIAL_ID,
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: {
      id: ISSUER_ID,
      type: ["Profile"],
      name: "Issuer University"
    },
    validFrom: "2026-07-14T10:00:00.000Z",
    validUntil: "2027-07-14T10:00:00.000Z",
    credentialSubject: {
      id: SUBJECT_ID,
      type: ["AchievementSubject"],
      achievement: {
        id: ACHIEVEMENT_ID,
        type: ["Achievement"],
        name: "Career Assurance",
        description: "Demonstrates bounded career decision assurance.",
        criteria: { narrative: "Completed the assessed assurance criteria." }
      }
    },
    proof: {
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-rdfc-2022",
      proofPurpose: "assertionMethod",
      verificationMethod: `${ISSUER_ID}#key-1`,
      proofValue: "zProofValue"
    },
    ...overrides
  };
}

function verificationDependencies(
  overrides: Partial<CredentialImportDependencies> = {}
): CredentialImportDependencies {
  return {
    schemaVerifier: {
      async validate() {
        return { valid: true, reasons: [] };
      }
    },
    cryptoVerifier: {
      async verifyCompactJws(request: CompactJwsVerificationRequest) {
        return {
          valid: true,
          algorithm: request.algorithm,
          signerId: ISSUER_ID,
          keyId: request.keyId,
          reasons: []
        };
      },
      async verifyDataIntegrity(request) {
        const proof = request.proofs[0];
        return {
          valid: true,
          algorithm: typeof proof?.cryptosuite === "string" ? proof.cryptosuite : "unsupported",
          signerId: ISSUER_ID,
          keyId: typeof proof?.verificationMethod === "string" ? proof.verificationMethod : null,
          reasons: []
        };
      }
    },
    ...overrides
  };
}

function importOptions(overrides: CredentialImportOptions = {}): CredentialImportOptions {
  return { now: NOW, expectedSubjectId: SUBJECT_ID, ...overrides };
}

function compactJws(
  credential: JsonObject,
  algorithm = "RS256",
  embeddedJwk?: JsonObject
): string {
  const jwk = embeddedJwk ?? (
    algorithm === "ES256"
      ? { kty: "EC", crv: "P-256", x: "AQAB", y: "AQAB" }
      : algorithm === "EdDSA"
        ? { kty: "OKP", crv: "Ed25519", x: "AQAB" }
        : algorithm.startsWith("RS") || algorithm.startsWith("PS")
          ? { kty: "RSA", n: "AQAB", e: "AQAB" }
          : { kty: "oct", k: "AQAB" }
  );
  const header = {
    alg: algorithm,
    typ: "JWT",
    jwk
  };
  const payload = {
    iss: ISSUER_ID,
    sub: SUBJECT_ID,
    jti: CREDENTIAL_ID,
    nbf: Date.parse("2026-07-14T10:00:00.000Z") / 1000,
    exp: Date.parse("2027-07-14T10:00:00.000Z") / 1000,
    vc: credential
  };
  return [header, payload]
    .map((value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url"))
    .concat(Buffer.from([1, 2, 3, 4]).toString("base64url"))
    .join(".");
}

function replaceJwsHeader(compact: string, header: JsonObject): string {
  const segments = compact.split(".");
  return [
    Buffer.from(JSON.stringify(header), "utf8").toString("base64url"),
    segments[1]!,
    segments[2]!
  ].join(".");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function bakedPng(serializedCredential: string, compressed = false): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const credentialData = Buffer.concat([
    Buffer.from("openbadgecredential\0", "latin1"),
    Buffer.from([compressed ? 1 : 0, 0, 0, 0]),
    Buffer.from(serializedCredential, "utf8")
  ]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("iTXt", credentialData),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function verifiedJwsEntry(credential = baseCredential()) {
  return importCredential(
    { content: compactJws(credential), format: "compact-jws" },
    verificationDependencies(),
    importOptions()
  );
}

describe("Credential Passport", () => {
  it("keeps parsing separate from seven independent verification checks", async () => {
    const serialized = JSON.stringify(baseCredential());
    const result = await importCredential(
      { content: serialized, format: "json-ld" },
      { schemaVerifier: verificationDependencies().schemaVerifier! },
      importOptions()
    );

    expect(result.entry.original.hash).toBe(sha256(serialized));
    expect(result.entry.verification.schema.status).toBe("pass");
    expect(result.entry.verification.signature).toMatchObject({
      status: "not-checked",
      code: "unsupported-proof"
    });
    expect(result.entry.verification.issuer.status).toBe("not-checked");
    expect(result.entry.verification.subject.status).toBe("pass");
    expect(result.entry.verification.time.status).toBe("pass");
    expect(result.entry.verification.revocation.status).toBe("not-applicable");
    expect(result.entry.verification.refresh.status).toBe("not-applicable");
    expect(result.entry.verification.overall).toBe("incomplete");
    expect(result.entry.verification.eligibleForMapping).toBe(false);
    expect(Buffer.from(result.preservedOriginal.bytes).equals(Buffer.from(serialized))).toBe(true);
    expect(validateCredentialContract("credential-passport", result.entry).valid).toBe(true);
  });

  it("verifies a Compact JWS only through the injected verifier and preserves the exact envelope hash", async () => {
    const serialized = compactJws(baseCredential());
    const result = await importCredential(
      { content: serialized, format: "compact-jws" },
      verificationDependencies(),
      importOptions()
    );

    expect(result.entry.original.hash).toBe(sha256(serialized));
    expect(result.entry.envelopeFormat).toBe("compact-jws");
    expect(result.entry.verification).toMatchObject({
      schema: { status: "pass" },
      signature: { status: "pass" },
      issuer: { status: "pass" },
      subject: { status: "pass" },
      time: { status: "pass" },
      revocation: { status: "not-applicable" },
      refresh: { status: "not-applicable" },
      overall: "verified",
      eligibleForMapping: true
    });
    expect(result.entry.verification.signature.details).toEqual(
      expect.arrayContaining(["algorithm:RS256", `signer:${ISSUER_ID}`])
    );
  });

  it("rejects JOSE algorithm confusion before invoking crypto", async () => {
    const verifyCompactJws = vi.fn();
    const dependencies = verificationDependencies({
      cryptoVerifier: {
        verifyCompactJws,
        async verifyDataIntegrity() {
          throw new Error("not used");
        }
      }
    });

    await expect(importCredential(
      { content: compactJws(baseCredential(), "HS256"), format: "compact-jws" },
      dependencies,
      importOptions({ allowedAlgorithms: ["RS256"] })
    )).rejects.toMatchObject({ code: "jws-algorithm-prohibited" });
    expect(verifyCompactJws).not.toHaveBeenCalled();

    await expect(importCredential(
      {
        content: compactJws(
          baseCredential(),
          "ES256",
          { kty: "EC", crv: "P-384", x: "AQAB", y: "AQAB" }
        ),
        format: "compact-jws"
      },
      dependencies,
      importOptions({ allowedAlgorithms: ["ES256"] })
    )).rejects.toMatchObject({ code: "jws-key-parameters-invalid" });
    expect(verifyCompactJws).not.toHaveBeenCalled();
  });

  it("rejects a verifier result that reports a different JOSE algorithm", async () => {
    const result = await importCredential(
      { content: compactJws(baseCredential()), format: "compact-jws" },
      verificationDependencies({
        cryptoVerifier: {
          async verifyCompactJws(request) {
            return {
              valid: true,
              algorithm: "ES256",
              signerId: ISSUER_ID,
              keyId: request.keyId,
              reasons: []
            };
          },
          async verifyDataIntegrity() {
            throw new Error("not used");
          }
        }
      }),
      importOptions()
    );

    expect(result.entry.verification.signature).toMatchObject({
      status: "fail",
      code: "signature-algorithm-confusion"
    });
    expect(result.entry.verification.overall).toBe("rejected");
  });

  it("rejects malformed JOSE key references before invoking crypto", async () => {
    const base = compactJws(baseCredential());
    const inputs: Array<[JsonObject, string]> = [
      [{ alg: "RS256", typ: "JWT" }, "jws-key-reference-invalid"],
      [{ alg: "RS256", typ: "JWT", kid: "http://issuer.example/key" }, "jws-key-id-invalid"],
      [{
        alg: "RS256",
        typ: "JWT",
        jwk: { kty: "RSA", n: "AQAB", e: "AQAB", d: "private" }
      }, "jws-private-key-prohibited"],
      [{
        alg: "RS256",
        typ: "JWT",
        crit: ["exp"],
        jwk: { kty: "RSA", n: "AQAB", e: "AQAB" }
      }, "jws-header-field-prohibited"]
    ];

    for (const [header, code] of inputs) {
      await expect(importCredential(
        { content: replaceJwsHeader(base, header), format: "compact-jws" },
        verificationDependencies(),
        importOptions()
      )).rejects.toMatchObject({ code });
    }
  });

  it("keeps unavailable status and refresh verification independent and incomplete", async () => {
    const credential = baseCredential({
      credentialStatus: {
        id: "https://issuer.example/status/1#0",
        type: "BitstringStatusListEntry"
      },
      refreshService: {
        id: "https://issuer.example/refresh/1",
        type: "ManualRefreshService2026"
      }
    });
    const result = await importCredential(
      { content: JSON.stringify(credential), format: "json-ld" },
      verificationDependencies(),
      importOptions()
    );

    expect(result.entry.verification.revocation).toMatchObject({
      status: "not-checked",
      code: "status-verifier-unavailable"
    });
    expect(result.entry.verification.refresh).toMatchObject({
      status: "not-checked",
      code: "refresh-verifier-unavailable"
    });
    expect(result.entry.verification.overall).toBe("incomplete");
    expect(result.entry.verification.eligibleForMapping).toBe(false);
  });

  it("enforces URL, redirect, byte, and media bounds around injected document loading", async () => {
    const allowed = "https://issuer.example/schema/1";
    const request = { url: allowed, purpose: "schema" as const, maxBytes: 4 };
    const success = createSafeCredentialDocumentLoader({
      async load(input) {
        return { url: input.url, mediaType: "APPLICATION/JSON", bytes: Uint8Array.of(1, 2) };
      }
    }, new Set([allowed]), 8);
    await expect(success.load(request)).resolves.toMatchObject({
      url: allowed,
      mediaType: "application/json"
    });
    await expect(success.load({ ...request, url: "https://attacker.example/schema" }))
      .rejects.toMatchObject({ code: "document-url-not-allowlisted" });

    const local = createSafeCredentialDocumentLoader(undefined, new Set(["https://127.0.0.1/schema"]), 8);
    await expect(local.load({ ...request, url: "https://127.0.0.1/schema" }))
      .rejects.toMatchObject({ code: "document-url-private-network" });

    const malformed = createSafeCredentialDocumentLoader(undefined, new Set(["not a url"]), 8);
    await expect(malformed.load({ ...request, url: "not a url" }))
      .rejects.toMatchObject({ code: "document-url-invalid" });

    const didUrl = "did:example:issuer#key-1";
    const did = createSafeCredentialDocumentLoader({
      async load(input) {
        return { url: input.url, mediaType: "application/did+json", bytes: Uint8Array.of(1) };
      }
    }, new Set([didUrl]), 8);
    await expect(did.load({ url: didUrl, purpose: "status", maxBytes: 4 }))
      .rejects.toMatchObject({ code: "document-url-prohibited" });
    await expect(did.load({ url: didUrl, purpose: "verification-method", maxBytes: 4 }))
      .resolves.toMatchObject({ url: didUrl });

    const insecure = createSafeCredentialDocumentLoader(undefined, new Set(["http://issuer.example/schema"]), 8);
    await expect(insecure.load({ ...request, url: "http://issuer.example/schema" }))
      .rejects.toMatchObject({ code: "document-url-prohibited" });

    await expect(success.load({ ...request, maxBytes: 0 }))
      .rejects.toMatchObject({ code: "document-limit-invalid" });

    const redirect = createSafeCredentialDocumentLoader({
      async load() {
        return {
          url: "https://issuer.example/redirected",
          mediaType: "application/json",
          bytes: Uint8Array.of(1)
        };
      }
    }, new Set([allowed]), 8);
    await expect(redirect.load(request)).rejects.toMatchObject({ code: "document-redirect-prohibited" });

    const oversized = createSafeCredentialDocumentLoader({
      async load(input) {
        return {
          url: input.url,
          mediaType: "application/json",
          bytes: Uint8Array.of(1, 2, 3, 4, 5)
        };
      }
    }, new Set([allowed]), 8);
    await expect(oversized.load(request)).rejects.toMatchObject({ code: "document-too-large" });

    const invalidMedia = createSafeCredentialDocumentLoader({
      async load(input) {
        return { url: input.url, mediaType: "", bytes: Uint8Array.of(1) };
      }
    }, new Set([allowed]), 8);
    await expect(invalidMedia.load(request)).rejects.toMatchObject({ code: "document-media-type-invalid" });
    const collected = collectCredentialDocumentUrls(
      {
        issuer: ISSUER_ID,
        credentialSchema: { id: allowed },
        credentialStatus: [{
          id: "https://issuer.example/status/entry",
          statusListCredential: "https://issuer.example/status/list"
        }],
        refreshService: { id: "https://issuer.example/refresh/1" },
        proof: { verificationMethod: didUrl }
      },
      didUrl,
      [VC_CONTEXT_URL],
      ["https://issuer.example/explicit"]
    );
    expect(collected).toEqual(new Set([
      VC_CONTEXT_URL,
      "https://issuer.example/explicit",
      didUrl,
      ISSUER_ID,
      allowed,
      "https://issuer.example/status/entry",
      "https://issuer.example/status/list",
      "https://issuer.example/refresh/1"
    ]));
    expect(validateCredentialSchemaFiles()).toEqual({ valid: true, errors: [] });
  });

  it("reports forged and expired credentials without making them mapping eligible", async () => {
    const forged = await importCredential(
      { content: JSON.stringify(baseCredential()), format: "json-ld" },
      verificationDependencies({
        cryptoVerifier: {
          async verifyCompactJws(request) {
            return { valid: false, algorithm: request.algorithm, signerId: null, keyId: null, reasons: [] };
          },
          async verifyDataIntegrity(request) {
            return {
              valid: false,
              algorithm: String(request.proofs[0]?.cryptosuite ?? "eddsa-rdfc-2022"),
              signerId: null,
              keyId: null,
              reasons: ["forged-proof"]
            };
          }
        }
      }),
      importOptions()
    );
    expect(forged.entry.verification.signature).toMatchObject({ status: "fail", code: "signature-invalid" });
    expect(forged.entry.verification.issuer.status).toBe("fail");
    expect(forged.entry.verification.eligibleForMapping).toBe(false);

    const expired = await importCredential(
      {
        content: JSON.stringify(baseCredential({ validUntil: "2026-07-14T12:29:59.000Z" })),
        format: "json-ld"
      },
      verificationDependencies(),
      importOptions()
    );
    expect(expired.entry.verification.time).toMatchObject({ status: "fail", code: "credential-expired" });
    expect(expired.entry.verification.eligibleForMapping).toBe(false);
  });

  it("fails closed for unknown, inline, unresolved, and unsupported proof contexts", async () => {
    await expect(importCredential(
      {
        content: JSON.stringify(baseCredential({
          "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL, "https://context.example/unsafe"]
        })),
        format: "json-ld"
      },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "jsonld-context-not-allowlisted" });

    await expect(importCredential(
      {
        content: JSON.stringify(baseCredential({
          "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL, { unsafe: "https://context.example/term" }]
        })),
        format: "json-ld"
      },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "jsonld-inline-context-prohibited" });

    const extensionUrl = "https://context.example/extension";
    const unresolved = await importCredential(
      {
        content: JSON.stringify(baseCredential({
          "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL, extensionUrl]
        })),
        format: "json-ld"
      },
      verificationDependencies(),
      importOptions({ allowedContextUrls: [extensionUrl] })
    );
    expect(unresolved.entry.verification.schema).toMatchObject({
      status: "fail",
      code: "credential-structure-invalid"
    });
    expect(unresolved.entry.verification.schema.details).toContain(`jsonld-context-unresolved:${extensionUrl}`);

    await expect(importCredential(
      {
        content: JSON.stringify(baseCredential({
          proof: {
            type: "DataIntegrityProof",
            cryptosuite: "invented-suite-1",
            proofPurpose: "assertionMethod",
            verificationMethod: `${ISSUER_ID}#key-1`,
            proofValue: "zProofValue"
          }
        })),
        format: "json-ld"
      },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "credential-proof-cryptosuite-prohibited" });
  });

  it("rejects duplicate JSON members and input that exceeds configured bounds", async () => {
    const duplicate = `{"@context":[],"id":"${CREDENTIAL_ID}","id":"https://attacker.example/credential"}`;
    await expect(importCredential(
      { content: duplicate, format: "json" },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "json-duplicate-key" });

    await expect(importCredential(
      { content: JSON.stringify(baseCredential()), format: "json-ld" },
      verificationDependencies(),
      importOptions({ maxInputBytes: 32 })
    )).rejects.toMatchObject({ code: "credential-input-too-large" });

    const nonFinite = JSON.stringify(baseCredential()).replace(
      '"validFrom"',
      '"nonFinite":1e999,"validFrom"'
    );
    await expect(importCredential(
      { content: nonFinite, format: "json-ld" },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "json-number-out-of-range" });
  });

  it("imports CRC checked baked PNG and single element SVG without changing the source hash", async () => {
    const serialized = JSON.stringify(baseCredential());
    const jsonResult = await importCredential(
      { content: serialized, format: "json" },
      verificationDependencies(),
      importOptions()
    );
    expect(jsonResult.entry.original.format).toBe("json");
    expect(jsonResult.entry.verification.overall).toBe("verified");

    const png = bakedPng(serialized);
    const pngResult = await importCredential(
      { content: png, format: "baked-png" },
      verificationDependencies(),
      importOptions()
    );
    expect(pngResult.entry.original.hash).toBe(sha256(png));
    expect(pngResult.entry.original.format).toBe("baked-png");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:openbadges="https://purl.imsglobal.org/ob/v3p0"><openbadges:credential><![CDATA[${serialized}]]></openbadges:credential></svg>`;
    const svgResult = await importCredential(
      { content: svg },
      verificationDependencies(),
      importOptions()
    );
    expect(svgResult.entry.original.hash).toBe(sha256(svg));
    expect(svgResult.entry.original.format).toBe("baked-svg");

    const svgJws = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:openbadges="https://purl.imsglobal.org/ob/v3p0"><openbadges:credential verify="${compactJws(baseCredential())}"></openbadges:credential></svg>`;
    const svgJwsResult = await importCredential(
      { content: svgJws, format: "baked-svg" },
      verificationDependencies(),
      importOptions()
    );
    expect(svgJwsResult.entry.envelopeFormat).toBe("compact-jws");
    expect(svgJwsResult.entry.verification.signature.status).toBe("pass");

    await expect(importCredential(
      { content: bakedPng(serialized, true), format: "baked-png" },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "png-credential-compressed" });

    const activeSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:openbadges="https://purl.imsglobal.org/ob/v3p0"><script>ignored()</script><openbadges:credential><![CDATA[${serialized}]]></openbadges:credential></svg>`;
    await expect(importCredential(
      { content: activeSvg, format: "baked-svg" },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "svg-active-content-prohibited" });
  });

  it("rejects SVG external entity declarations before credential extraction", async () => {
    const maliciousSvg = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:openbadges="https://purl.imsglobal.org/ob/v3p0">',
      "<openbadges:credential><![CDATA[{}]]></openbadges:credential>",
      "</svg>"
    ].join("\n");
    await expect(importCredential(
      { content: maliciousSvg, format: "baked-svg" },
      verificationDependencies(),
      importOptions()
    )).rejects.toMatchObject({ code: "svg-xml-entity-prohibited" });
  });

  it("reports revocation and refresh separately and never refreshes an unverified original", async () => {
    const credential = baseCredential({
      credentialStatus: {
        id: "https://issuer.example/status/1",
        type: "BitstringStatusListEntry"
      },
      refreshService: {
        id: "https://issuer.example/refresh/1",
        type: "1EdTechCredentialRefresh"
      }
    });
    const result = await importCredential(
      { content: JSON.stringify(credential), format: "json-ld" },
      verificationDependencies({
        statusVerifier: {
          async checkRevocation() {
            return { checked: true, revoked: true, reasons: ["status-list-bit-set"] };
          },
          async checkRefresh() {
            return {
              checked: true,
              valid: true,
              refreshedCredentialHash: sha256("refreshed"),
              reasons: ["refresh-response-bound"]
            };
          }
        }
      }),
      importOptions()
    );
    expect(result.entry.verification.revocation).toMatchObject({ status: "fail", code: "credential-revoked" });
    expect(result.entry.verification.refresh).toMatchObject({ status: "pass", code: "refresh-valid" });
    expect(result.entry.verification.overall).toBe("rejected");

    const checkRefresh = vi.fn();
    const failedProof = await importCredential(
      { content: JSON.stringify(credential), format: "json-ld" },
      verificationDependencies({
        cryptoVerifier: {
          async verifyCompactJws(request) {
            return { valid: false, algorithm: request.algorithm, signerId: null, keyId: null, reasons: [] };
          },
          async verifyDataIntegrity(request) {
            return {
              valid: false,
              algorithm: String(request.proofs[0]?.cryptosuite ?? "eddsa-rdfc-2022"),
              signerId: null,
              keyId: null,
              reasons: ["proof-invalid"]
            };
          }
        },
        statusVerifier: {
          async checkRevocation() {
            return { checked: true, revoked: false, reasons: [] };
          },
          checkRefresh
        }
      }),
      importOptions()
    );
    expect(checkRefresh).not.toHaveBeenCalled();
    expect(failedProof.entry.verification.refresh).toMatchObject({
      status: "not-checked",
      code: "refresh-blocked-unverified-original"
    });
  });

  it("requires a hash bound approval and keeps public and automatic flags false by default", async () => {
    const { entry } = await verifiedJwsEntry();
    const pending = createCredentialClaimMapping(entry, {
      mappingId: "MAPPING-001",
      claimType: "credential",
      claimText: "Earned the Career Assurance credential."
    });
    expect(pending).toMatchObject({
      requestedPublic: false,
      requestedAutoApply: false,
      publiclyAssertable: false,
      allowedInAutoApply: false,
      status: "pending",
      approval: null
    });
    expect(() => addCredentialMapping(entry, pending)).toThrow("requires explicit approval");

    const requested = createCredentialClaimMapping(entry, {
      mappingId: "MAPPING-002",
      claimType: "credential",
      claimText: "Earned the Career Assurance credential.",
      requestedPublic: true,
      requestedAutoApply: true
    });
    const approval: CredentialMappingApproval = {
      approvalId: "APPROVAL-MAPPING-001",
      approverPrincipalId: "HUMAN-MAPPER",
      approvedAt: "2026-07-14T12:10:00.000Z",
      expiresAt: "2026-07-14T13:10:00.000Z",
      mappingHash: requested.mappingHash,
      allowPublic: true,
      allowAutoApply: true,
      signatureReceiptHash: sha256("mapping-approval")
    };
    const approved = approveCredentialClaimMapping(entry, requested, approval, NOW);
    expect(approved).toMatchObject({
      publiclyAssertable: true,
      allowedInAutoApply: true,
      status: "approved"
    });
    const updated = addCredentialMapping(entry, approved, NOW);
    expect(updated.mappings).toHaveLength(1);
    expect(validateCredentialContract("credential-mapping", approved).valid).toBe(true);
    expect(() => addCredentialMapping(updated, approved, NOW)).toThrow("already exists");
    expect(() => addCredentialMapping(
      entry,
      approved,
      new Date("2026-07-14T13:10:00.000Z")
    )).toThrow("not currently valid");

    expect(() => addCredentialMapping(entry, {
      ...approved,
      publiclyAssertable: false
    }, NOW)).toThrow("flags do not match");

    expect(() => addCredentialMapping(entry, {
      ...approved,
      approval: { ...approval, mappingHash: sha256("forged-approval") }
    }, NOW)).toThrow("approval hash does not match");

    expect(() => approveCredentialClaimMapping(
      entry,
      requested,
      { ...approval, mappingHash: sha256("wrong-mapping") },
      NOW
    )).toThrow("hash does not match");
  });

  it("blocks public mapping for audience restricted credentials", async () => {
    const credential = baseCredential({
      termsOfUse: [{ type: "IssuerPolicy", id: "https://issuer.example/policy/private-audience" }]
    });
    const { entry } = await verifiedJwsEntry(credential);
    const mapping = createCredentialClaimMapping(entry, {
      mappingId: "MAPPING-AUDIENCE-001",
      claimType: "credential",
      claimText: "Earned an audience restricted credential.",
      requestedPublic: true
    });
    expect(() => approveCredentialClaimMapping(entry, mapping, {
      approvalId: "APPROVAL-AUDIENCE-001",
      approverPrincipalId: "HUMAN-MAPPER",
      approvedAt: "2026-07-14T12:10:00.000Z",
      expiresAt: "2026-07-14T13:10:00.000Z",
      mappingHash: mapping.mappingHash,
      allowPublic: true,
      allowAutoApply: false,
      signatureReceiptHash: sha256("audience-approval")
    }, NOW)).toThrow("Audience restricted credentials");
  });
});
