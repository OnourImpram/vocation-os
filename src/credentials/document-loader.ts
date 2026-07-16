import { isIP } from "node:net";
import { CredentialImportError } from "./errors.js";
import type {
  CredentialDocumentLoader,
  CredentialDocumentPurpose,
  CredentialLoadedDocument,
  JsonObject,
  JsonValue
} from "./types.js";

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectId(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value;
  if (!isJsonObject(value)) return null;
  return typeof value.id === "string" ? value.id : null;
}

function addObjectUrls(value: JsonValue | undefined, fields: readonly string[], urls: Set<string>): void {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    if (!isJsonObject(candidate)) continue;
    for (const field of fields) {
      const fieldValue = candidate[field];
      if (typeof fieldValue === "string") urls.add(fieldValue);
    }
  }
}

function assertSafeDocumentUrl(url: string, purpose: CredentialDocumentPurpose): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CredentialImportError("document-url-invalid", `Credential document URL is invalid: ${url}`);
  }
  if (parsed.protocol === "did:") {
    if (purpose !== "verification-method" && purpose !== "issuer") {
      throw new CredentialImportError("document-url-prohibited", `DID URL is not allowed for ${purpose}`);
    }
    return;
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new CredentialImportError("document-url-prohibited", "Credential documents must use public HTTPS URLs");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isIP(hostname) !== 0
  ) {
    throw new CredentialImportError("document-url-private-network", "Credential document URL targets a local or literal IP host");
  }
}

export function collectCredentialDocumentUrls(
  credential: JsonObject,
  keyId: string | null,
  contextUrls: readonly string[],
  explicitlyAllowedUrls: readonly string[]
): ReadonlySet<string> {
  const urls = new Set<string>([...contextUrls, ...explicitlyAllowedUrls]);
  if (keyId !== null) urls.add(keyId);
  const issuer = objectId(credential.issuer);
  if (issuer !== null) urls.add(issuer);
  addObjectUrls(credential.credentialSchema, ["id"], urls);
  addObjectUrls(credential.credentialStatus, ["id", "statusListCredential"], urls);
  addObjectUrls(credential.refreshService, ["id"], urls);
  addObjectUrls(credential.proof, ["verificationMethod"], urls);
  return urls;
}

export function createSafeCredentialDocumentLoader(
  delegate: CredentialDocumentLoader | undefined,
  allowedUrls: ReadonlySet<string>,
  maxDocumentBytes: number
): CredentialDocumentLoader {
  return {
    async load(request): Promise<CredentialLoadedDocument> {
      if (!allowedUrls.has(request.url)) {
        throw new CredentialImportError("document-url-not-allowlisted", `Credential document URL is not allowlisted: ${request.url}`);
      }
      assertSafeDocumentUrl(request.url, request.purpose);
      if (!delegate) throw new CredentialImportError("document-loader-unavailable", "Credential document loader is not configured");
      const effectiveMaxBytes = Math.min(request.maxBytes, maxDocumentBytes);
      if (!Number.isSafeInteger(effectiveMaxBytes) || effectiveMaxBytes <= 0) {
        throw new CredentialImportError("document-limit-invalid", "Credential document byte limit is invalid");
      }
      const loaded = await delegate.load({ ...request, maxBytes: effectiveMaxBytes });
      if (loaded.url !== request.url) {
        throw new CredentialImportError("document-redirect-prohibited", "Credential document loader returned a redirected URL");
      }
      if (loaded.bytes.byteLength > effectiveMaxBytes) {
        throw new CredentialImportError("document-too-large", "Credential document exceeds the configured byte limit");
      }
      if (
        loaded.mediaType.trim().length === 0 ||
        loaded.mediaType.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(loaded.mediaType)
      ) {
        throw new CredentialImportError("document-media-type-invalid", "Credential document media type is invalid");
      }
      return {
        url: loaded.url,
        mediaType: loaded.mediaType.toLowerCase(),
        bytes: Uint8Array.from(loaded.bytes)
      };
    }
  };
}
