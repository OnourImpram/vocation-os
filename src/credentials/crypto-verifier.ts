import { DataIntegrityProof } from "@digitalbazaar/data-integrity";
import { cryptosuite as eddsaRdfc2022Cryptosuite } from "@digitalbazaar/eddsa-rdfc-2022-cryptosuite";
import jsonLdSignatures from "jsonld-signatures";
import { parseJsonObjectStrict } from "./envelope.js";
import {
  JoseCredentialCryptoVerifier,
  type JoseCredentialCryptoVerifierOptions
} from "./jose-verifier.js";
import type {
  CompactJwsVerificationRequest,
  CredentialCryptoVerificationResult,
  CredentialCryptoVerifier,
  CredentialDocumentLoader,
  DataIntegrityVerificationRequest,
  JsonObject,
  JsonValue
} from "./types.js";

const EDDSA_RDFC_2022 = "eddsa-rdfc-2022";
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;

export interface CredentialCryptoVerifierOptions extends JoseCredentialCryptoVerifierOptions {
  maxDataIntegrityDocumentBytes?: number;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(object: JsonObject, field: string): string | null {
  const value = object[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function issuerId(credential: JsonObject): string | null {
  if (typeof credential.issuer === "string" && credential.issuer.length > 0) return credential.issuer;
  return isJsonObject(credential.issuer) ? stringField(credential.issuer, "id") : null;
}

function invalidDataIntegrityResult(
  reason: string,
  keyId: string | null = null
): CredentialCryptoVerificationResult {
  return {
    valid: false,
    algorithm: EDDSA_RDFC_2022,
    signerId: null,
    keyId,
    reasons: [reason]
  };
}

function proofVerificationMethod(proof: JsonObject): string | null {
  const value = proof.verificationMethod;
  if (typeof value === "string" && value.length > 0) return value;
  return isJsonObject(value) ? stringField(value, "id") : null;
}

function contextUrls(credential: JsonObject): ReadonlySet<string> {
  const values = Array.isArray(credential["@context"])
    ? credential["@context"]
    : [credential["@context"]];
  return new Set(values.filter((value): value is string => typeof value === "string"));
}

function assertDocumentByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 8 * 1024 * 1024) {
    throw new TypeError("Data Integrity document byte limit must be between 1024 and 8388608");
  }
  return value;
}

export class BoundedCredentialCryptoVerifier implements CredentialCryptoVerifier {
  readonly #jose: JoseCredentialCryptoVerifier;
  readonly #maxDocumentBytes: number;

  constructor(options: CredentialCryptoVerifierOptions) {
    this.#jose = new JoseCredentialCryptoVerifier(options);
    this.#maxDocumentBytes = assertDocumentByteLimit(
      options.maxDataIntegrityDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
    );
  }

  async verifyCompactJws(
    request: CompactJwsVerificationRequest,
    loader: CredentialDocumentLoader
  ): Promise<CredentialCryptoVerificationResult> {
    return this.#jose.verifyCompactJws(request, loader);
  }

  async verifyDataIntegrity(
    request: DataIntegrityVerificationRequest,
    loader: CredentialDocumentLoader
  ): Promise<CredentialCryptoVerificationResult> {
    if (!request.allowedCryptosuites.includes(EDDSA_RDFC_2022)) {
      return invalidDataIntegrityResult("data-integrity-cryptosuite-prohibited");
    }
    if (request.proofs.length !== 1) {
      return invalidDataIntegrityResult("data-integrity-proof-cardinality-unsupported");
    }
    const proof = request.proofs[0]!;
    if (stringField(proof, "cryptosuite") !== EDDSA_RDFC_2022) {
      return invalidDataIntegrityResult("data-integrity-cryptosuite-unsupported");
    }
    const keyId = proofVerificationMethod(proof);
    if (keyId === null) return invalidDataIntegrityResult("data-integrity-verification-method-missing");
    const issuer = issuerId(request.credential);
    if (issuer === null) return invalidDataIntegrityResult("data-integrity-issuer-missing", keyId);

    const credentialContextUrls = contextUrls(request.credential);
    const jsonLdDocumentLoader = async (url: string): Promise<{
      contextUrl: string | null;
      documentUrl: string;
      document: JsonObject;
    }> => {
      const loaded = await loader.load({
        url,
        purpose: credentialContextUrls.has(url) ? "context" : "verification-method",
        maxBytes: this.#maxDocumentBytes
      });
      if (loaded.url !== url || loaded.bytes.byteLength > this.#maxDocumentBytes) {
        throw new Error("data-integrity-document-binding-invalid");
      }
      return {
        contextUrl: null,
        documentUrl: loaded.url,
        document: parseJsonObjectStrict(
          new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes),
          MAX_JSON_DEPTH
        )
      };
    };

    try {
      const issuerDocument = await jsonLdDocumentLoader(issuer);
      if (stringField(issuerDocument.document, "id") !== issuer) {
        return invalidDataIntegrityResult("data-integrity-issuer-document-mismatch", keyId);
      }
      const isolatedCredential = { ...request.credential, proof };
      const suite = new DataIntegrityProof({ cryptosuite: eddsaRdfc2022Cryptosuite });
      const result = await jsonLdSignatures.verify(isolatedCredential, {
        suite,
        purpose: new jsonLdSignatures.purposes.AssertionProofPurpose({
          controller: issuerDocument.document
        }),
        documentLoader: jsonLdDocumentLoader
      });
      if (!result.verified || result.results?.some((entry) => entry.verified === false)) {
        return invalidDataIntegrityResult("data-integrity-cryptographic-verification-failed", keyId);
      }
      return {
        valid: true,
        algorithm: EDDSA_RDFC_2022,
        signerId: issuer,
        keyId,
        reasons: []
      };
    } catch {
      return invalidDataIntegrityResult("data-integrity-cryptographic-verification-failed", keyId);
    }
  }
}

export function createCredentialCryptoVerifier(
  options: CredentialCryptoVerifierOptions
): CredentialCryptoVerifier {
  return new BoundedCredentialCryptoVerifier(options);
}
