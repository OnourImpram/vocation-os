import { DataIntegrityProof } from "@digitalbazaar/data-integrity";
import * as Ed25519Multikey from "@digitalbazaar/ed25519-multikey";
import { cryptosuite as eddsaRdfc2022Cryptosuite } from "@digitalbazaar/eddsa-rdfc-2022-cryptosuite";
import jsonLdSignatures from "jsonld-signatures";
import { describe, expect, it } from "vitest";
import {
  OPEN_BADGES_CONTEXT_URL,
  VC_CONTEXT_URL,
  createCredentialCryptoVerifier,
  createLocalCredentialDocumentLoader,
  importCredential,
  type CredentialDocumentLoader,
  type JsonObject
} from "../../src/credentials/index.js";

const NOW = new Date("2026-07-14T12:30:00.000Z");
const ISSUER_ID = "https://issuer.example/issuers/data-integrity";
const SUBJECT_ID = "did:example:data-integrity-holder";
const DATA_INTEGRITY_CONTEXT_URL = "https://w3id.org/security/data-integrity/v2";
const DID_CONTEXT_URL = "https://www.w3.org/ns/did/v1";
const MULTIKEY_CONTEXT_URL = "https://w3id.org/security/multikey/v1";

interface SignedFixture {
  credential: JsonObject;
  documentLoader: CredentialDocumentLoader;
  controllerDocument: JsonObject;
  issuerId: string;
}

function mappedDocumentLoader(documents: ReadonlyMap<string, JsonObject>): CredentialDocumentLoader {
  return {
    async load(request) {
      const document = documents.get(request.url);
      if (!document) throw new Error(`Fixture document not found: ${request.url}`);
      return {
        url: request.url,
        mediaType: request.url.startsWith("did:") ? "application/did+ld+json" : "application/ld+json",
        bytes: Uint8Array.from(Buffer.from(JSON.stringify(document), "utf8"))
      };
    }
  };
}

async function jsonLdLoader(loader: CredentialDocumentLoader, url: string) {
  const loaded = await loader.load({ url, purpose: "verification-method", maxBytes: 1024 * 1024 });
  return {
    contextUrl: null,
    documentUrl: loaded.url,
    document: JSON.parse(new TextDecoder().decode(loaded.bytes)) as JsonObject
  };
}

async function signedFixture(mode: "https" | "did-key" = "https"): Promise<SignedFixture> {
  const keyPair = await Ed25519Multikey.generate({ controller: ISSUER_ID });
  const issuerId = mode === "did-key" ? `did:key:${keyPair.publicKeyMultibase}` : ISSUER_ID;
  if (mode === "did-key") {
    keyPair.controller = issuerId;
    keyPair.id = `${issuerId}#${keyPair.publicKeyMultibase}`;
  }
  const publicKey = await keyPair.export({ publicKey: true, includeContext: true }) as JsonObject;
  const controllerDocument: JsonObject = {
    "@context": [DID_CONTEXT_URL, MULTIKEY_CONTEXT_URL],
    id: issuerId,
    verificationMethod: [publicKey],
    assertionMethod: [publicKey]
  };
  const fallback = mappedDocumentLoader(new Map([
    [issuerId, controllerDocument],
    [keyPair.id, publicKey]
  ]));
  const documentLoader = createLocalCredentialDocumentLoader(mode === "https" ? fallback : undefined);
  const unsignedCredential: JsonObject = {
    "@context": [VC_CONTEXT_URL, OPEN_BADGES_CONTEXT_URL, DATA_INTEGRITY_CONTEXT_URL],
    id: "https://issuer.example/credentials/data-integrity-1",
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: {
      id: issuerId,
      type: ["Profile"],
      name: "Fixture University"
    },
    validFrom: "2026-07-14T10:00:00.000Z",
    validUntil: "2027-07-14T10:00:00.000Z",
    credentialSubject: {
      id: SUBJECT_ID,
      type: ["AchievementSubject"],
      achievement: {
        id: "https://issuer.example/achievements/data-integrity",
        type: ["Achievement"],
        name: "Evidence Integrity",
        description: "Demonstrates bounded credential verification.",
        criteria: { narrative: "Completed the evidence integrity criteria." }
      }
    }
  };
  const signed = await jsonLdSignatures.sign(unsignedCredential, {
    suite: new DataIntegrityProof({
      signer: keyPair.signer(),
      date: "2026-07-14T12:00:00.000Z",
      cryptosuite: eddsaRdfc2022Cryptosuite
    }),
    purpose: new jsonLdSignatures.purposes.AssertionProofPurpose(),
    documentLoader: (url) => jsonLdLoader(documentLoader, url)
  });
  return { credential: signed as JsonObject, documentLoader, controllerDocument, issuerId };
}

function dependencies(documentLoader: CredentialDocumentLoader) {
  return {
    cryptoVerifier: createCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] }),
    documentLoader
  };
}

describe("bounded Data Integrity credential verification", () => {
  it("cryptographically verifies an issuer-authorized eddsa-rdfc-2022 Open Badge", async () => {
    const fixture = await signedFixture();
    const result = await importCredential(
      { content: JSON.stringify(fixture.credential), format: "json-ld" },
      dependencies(fixture.documentLoader),
      { now: NOW, expectedSubjectId: SUBJECT_ID }
    );

    expect(result.entry.verification.signature).toMatchObject({
      status: "pass",
      code: "signature-valid"
    });
    expect(result.entry.verification.issuer).toMatchObject({ status: "pass", code: "issuer-verified" });
    expect(result.entry.verification.schema).toMatchObject({
      status: "not-checked",
      code: "schema-verifier-unavailable"
    });
    expect(result.entry.verification.overall).toBe("incomplete");
    expect(result.entry.verification.eligibleForMapping).toBe(false);
  });

  it("verifies a did:key issuer through the offline daemon resolver without a network delegate", async () => {
    const fixture = await signedFixture("did-key");
    const result = await importCredential(
      { content: JSON.stringify(fixture.credential), format: "json-ld" },
      dependencies(fixture.documentLoader),
      { now: NOW, expectedSubjectId: SUBJECT_ID }
    );

    expect(result.entry.verification.signature).toMatchObject({ status: "pass", code: "signature-valid" });
    expect(result.entry.verification.issuer).toMatchObject({ status: "pass", code: "issuer-verified" });
    expect(result.entry.verification.issuer.details).toEqual([]);
  });

  it("rejects a credential whose signed achievement text was altered", async () => {
    const fixture = await signedFixture();
    const tampered = structuredClone(fixture.credential);
    const subject = tampered.credentialSubject as JsonObject;
    const achievement = subject.achievement as JsonObject;
    achievement.name = "Inflated unverified achievement";

    const result = await importCredential(
      { content: JSON.stringify(tampered), format: "json-ld" },
      dependencies(fixture.documentLoader),
      { now: NOW, expectedSubjectId: SUBJECT_ID }
    );

    expect(result.entry.verification.signature).toMatchObject({ status: "fail", code: "signature-invalid" });
    expect(result.entry.verification.eligibleForMapping).toBe(false);
  });

  it("rejects a valid signature when the issuer no longer authorizes its verification method", async () => {
    const fixture = await signedFixture();
    const unauthorizedController = {
      ...fixture.controllerDocument,
      assertionMethod: []
    } as JsonObject;
    const proof = fixture.credential.proof as JsonObject;
    const keyId = proof.verificationMethod as string;
    const keyDocument = await fixture.documentLoader.load({
      url: keyId,
      purpose: "verification-method",
      maxBytes: 1024 * 1024
    });
    const loader = createLocalCredentialDocumentLoader(mappedDocumentLoader(new Map([
      [ISSUER_ID, unauthorizedController],
      [keyId, JSON.parse(new TextDecoder().decode(keyDocument.bytes)) as JsonObject]
    ])));

    const result = await importCredential(
      { content: JSON.stringify(fixture.credential), format: "json-ld" },
      dependencies(loader),
      { now: NOW, expectedSubjectId: SUBJECT_ID }
    );

    expect(result.entry.verification.signature).toMatchObject({ status: "fail", code: "signature-invalid" });
    expect(result.entry.verification.issuer.status).toBe("fail");
  });

  it("fails closed when the issuer document is unavailable", async () => {
    const fixture = await signedFixture();
    const result = await importCredential(
      { content: JSON.stringify(fixture.credential), format: "json-ld" },
      {
        cryptoVerifier: createCredentialCryptoVerifier({ allowedAlgorithms: ["RS256"] })
      },
      { now: NOW, expectedSubjectId: SUBJECT_ID }
    );

    expect(result.entry.verification.signature).toMatchObject({ status: "fail", code: "signature-invalid" });
    expect(result.entry.verification.eligibleForMapping).toBe(false);
  });

  it("does not accept one valid proof as cover for an additional proof", async () => {
    const fixture = await signedFixture();
    const proof = fixture.credential.proof as JsonObject;
    const multipleProofs = {
      ...fixture.credential,
      proof: [proof, { ...proof, proofValue: "zForgedProofValue" }]
    } as JsonObject;
    const result = await importCredential(
      { content: JSON.stringify(multipleProofs), format: "json-ld" },
      dependencies(fixture.documentLoader),
      { now: NOW, expectedSubjectId: SUBJECT_ID }
    );

    expect(result.entry.verification.signature.details).toContain(
      "data-integrity-proof-cardinality-unsupported"
    );
    expect(result.entry.verification.signature.status).toBe("fail");
  });
});
