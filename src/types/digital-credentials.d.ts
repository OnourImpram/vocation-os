declare module "@digitalbazaar/credentials-context" {
  export const contexts: Map<string, Record<string, unknown>>;
}

declare module "@digitalbazaar/data-integrity-context" {
  interface ContextPackage {
    contexts: Map<string, Record<string, unknown>>;
  }
  const contextPackage: ContextPackage;
  export default contextPackage;
}

declare module "@digitalbazaar/multikey-context" {
  interface ContextPackage {
    contexts: Map<string, Record<string, unknown>>;
  }
  const contextPackage: ContextPackage;
  export default contextPackage;
}

declare module "@digitalcredentials/open-badges-context" {
  interface OpenBadgesContextPackage {
    contexts: Map<string, Record<string, unknown>>;
    CONTEXT_URL_V3: string;
  }
  const contextPackage: OpenBadgesContextPackage;
  export default contextPackage;
}

declare module "@digitalbazaar/security-document-loader" {
  interface JsonLdRemoteDocument {
    contextUrl: string | null;
    documentUrl: string;
    document: Record<string, unknown>;
  }

  interface SecurityDocumentLoader {
    documents: Map<string, Record<string, unknown>>;
    addStatic(url: string, document: Record<string, unknown>): void;
    build(): (url: string) => Promise<JsonLdRemoteDocument>;
  }

  export function securityLoader(): SecurityDocumentLoader;
}

declare module "@digitalbazaar/data-integrity" {
  export class DataIntegrityProof {
    constructor(options: { cryptosuite: unknown; signer?: unknown; date?: string });
  }
}

declare module "@digitalbazaar/eddsa-rdfc-2022-cryptosuite" {
  export const cryptosuite: unknown;
}

declare module "jsonld-signatures" {
  interface VerificationResult {
    verified: boolean;
    results?: Array<{ verified?: boolean; error?: unknown }>;
    error?: unknown;
  }

  interface AssertionProofPurposeConstructor {
    new (options?: { controller?: Record<string, unknown> }): unknown;
  }

  interface JsonLdSignatures {
    purposes: {
      AssertionProofPurpose: AssertionProofPurposeConstructor;
    };
    verify(
      document: Record<string, unknown>,
      options: {
        suite: unknown;
        purpose: unknown;
        documentLoader: (url: string) => Promise<{
          contextUrl: string | null;
          documentUrl: string;
          document: Record<string, unknown>;
        }>;
      }
    ): Promise<VerificationResult>;
    sign(
      document: Record<string, unknown>,
      options: {
        suite: unknown;
        purpose: unknown;
        documentLoader: (url: string) => Promise<{
          contextUrl: string | null;
          documentUrl: string;
          document: Record<string, unknown>;
        }>;
      }
    ): Promise<Record<string, unknown>>;
  }

  const jsonLdSignatures: JsonLdSignatures;
  export default jsonLdSignatures;
}

declare module "@digitalbazaar/ed25519-multikey" {
  interface Ed25519Multikey {
    id: string;
    controller: string;
    publicKeyMultibase: string;
    signer(): unknown;
    export(options: { publicKey: boolean; includeContext: boolean }): Promise<Record<string, unknown>>;
  }

  export function generate(options: { controller: string }): Promise<Ed25519Multikey>;
}
