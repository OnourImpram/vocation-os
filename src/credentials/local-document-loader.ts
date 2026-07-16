import { contexts as credentialContexts } from "@digitalbazaar/credentials-context";
import dataIntegrityContext from "@digitalbazaar/data-integrity-context";
import multikeyContext from "@digitalbazaar/multikey-context";
import { securityLoader } from "@digitalbazaar/security-document-loader";
import openBadgesContext from "@digitalcredentials/open-badges-context";
import { CredentialImportError } from "./errors.js";
import type { CredentialDocumentLoader, JsonObject } from "./types.js";

interface JsonLdRemoteDocument {
  contextUrl: string | null;
  documentUrl: string;
  document: JsonObject;
}

interface LocalLoaderState {
  documentLoader: (url: string) => Promise<JsonLdRemoteDocument>;
  staticUrls: ReadonlySet<string>;
}

let localLoaderState: LocalLoaderState | undefined;

function addContexts(
  loader: ReturnType<typeof securityLoader>,
  contexts: ReadonlyMap<string, Record<string, unknown>>
): void {
  for (const [url, context] of contexts) loader.addStatic(url, context);
}

function buildLocalLoaderState(): LocalLoaderState {
  if (localLoaderState) return localLoaderState;
  const loader = securityLoader();
  addContexts(loader, credentialContexts);
  addContexts(loader, dataIntegrityContext.contexts);
  addContexts(loader, multikeyContext.contexts);
  addContexts(loader, openBadgesContext.contexts);
  localLoaderState = {
    documentLoader: loader.build() as LocalLoaderState["documentLoader"],
    staticUrls: new Set(loader.documents.keys())
  };
  return localLoaderState;
}

export function credentialStaticDocumentUrls(): ReadonlySet<string> {
  return buildLocalLoaderState().staticUrls;
}

export function credentialProofContextUrls(): ReadonlySet<string> {
  return new Set(dataIntegrityContext.contexts.keys());
}

export function createLocalCredentialDocumentLoader(
  fallback?: CredentialDocumentLoader
): CredentialDocumentLoader {
  const local = buildLocalLoaderState().documentLoader;
  return {
    async load(request) {
      try {
        const loaded = await local(request.url);
        const serialized = JSON.stringify(loaded.document);
        if (serialized === undefined) {
          throw new CredentialImportError(
            "credential-document-invalid",
            `Credential document is not serializable: ${request.url}`
          );
        }
        return {
          url: loaded.documentUrl,
          mediaType: request.url.startsWith("did:") ? "application/did+ld+json" : "application/ld+json",
          bytes: Uint8Array.from(Buffer.from(serialized, "utf8"))
        };
      } catch (error) {
        if (fallback && !request.url.startsWith("did:key:")) return fallback.load(request);
        if (error instanceof CredentialImportError) throw error;
        throw new CredentialImportError(
          "credential-document-unresolved",
          `Credential document could not be resolved from the local trust set: ${request.url}`
        );
      }
    }
  };
}
