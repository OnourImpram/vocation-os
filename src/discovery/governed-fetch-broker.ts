import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { sha256, stableStringify } from "../hash.js";
import {
  assertValidEgressManifest,
  assertValidNetworkAccessGrant,
  normalizeHostname,
  validateUrlAuthorization,
  type EgressManifest,
  type GovernedHttpMethod,
  type NetworkAccessGrant,
  type NetworkAccessGrantVerifier
} from "./governance.js";
import {
  NodeDnsResolver,
  validateResolvedAddresses,
  type DnsResolver,
  type ResolvedAddress
} from "./ip-policy.js";

export type GovernedFetchErrorCode =
  | "INVALID_MANIFEST"
  | "INVALID_GRANT"
  | "GRANT_VERIFICATION_FAILED"
  | "URL_NOT_AUTHORIZED"
  | "HEADER_NOT_AUTHORIZED"
  | "DNS_FAILURE"
  | "SSRF_BLOCKED"
  | "RATE_LIMITED"
  | "GRANT_BUDGET_EXHAUSTED"
  | "TIMEOUT"
  | "TRANSPORT_FAILURE"
  | "INVALID_RESPONSE"
  | "STATUS_NOT_ALLOWED"
  | "CONTENT_TYPE_NOT_ALLOWED"
  | "CONTENT_ENCODING_NOT_ALLOWED"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_NOT_ALLOWED"
  | "REDIRECT_LIMIT_EXCEEDED"
  | "REDIRECT_LOOP"
  | "CACHE_FAILURE"
  | "INVALID_JSON";

export class GovernedFetchError extends Error {
  public constructor(
    public readonly code: GovernedFetchErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GovernedFetchError";
  }
}

export interface TransportHeaders {
  get(name: string): string | null;
}

export type GovernedTransportBody = Uint8Array | AsyncIterable<Uint8Array> | null;

export interface GovernedFetchTransportResponse {
  readonly status: number;
  readonly headers: TransportHeaders;
  readonly body: GovernedTransportBody;
}

export interface GovernedFetchTransportRequest {
  readonly url: string;
  readonly method: GovernedHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly redirect: "manual";
  readonly approvedAddresses: readonly ResolvedAddress[];
}

export type GovernedFetchTransport = (
  request: GovernedFetchTransportRequest
) => Promise<GovernedFetchTransportResponse>;

export interface GovernedFetchCacheEntry {
  readonly cacheKey: string;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly bodyDigest: string;
  readonly redirects: readonly GovernedRedirect[];
  readonly storedAt: string;
  readonly expiresAt: string;
}

export interface GovernedFetchCache {
  get(key: string): Promise<GovernedFetchCacheEntry | null>;
  set(key: string, entry: GovernedFetchCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface EncryptedGovernedFetchCache extends GovernedFetchCache {
  readonly storageProtection: "authenticated-encryption";
}

function cloneCacheEntry(entry: GovernedFetchCacheEntry): GovernedFetchCacheEntry {
  return {
    ...entry,
    headers: { ...entry.headers },
    body: new Uint8Array(entry.body),
    redirects: entry.redirects.map((redirect) => ({ ...redirect }))
  };
}

export class MemoryGovernedFetchCache implements GovernedFetchCache {
  private readonly entries = new Map<string, GovernedFetchCacheEntry>();

  public async get(key: string): Promise<GovernedFetchCacheEntry | null> {
    const entry = this.entries.get(key);
    return entry ? cloneCacheEntry(entry) : null;
  }

  public async set(key: string, entry: GovernedFetchCacheEntry): Promise<void> {
    this.entries.set(key, cloneCacheEntry(entry));
  }

  public async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export interface GovernedRateGateRequest {
  readonly manifest: EgressManifest;
  readonly grant: NetworkAccessGrant;
  readonly consumedAt: number;
}

export interface GovernedRateGateDecision {
  readonly allowed: boolean;
  readonly reason?: "provider-rate-limit" | "grant-budget";
  readonly retryAfterMs: number;
}

export interface GovernedRateGate {
  consume(request: GovernedRateGateRequest): Promise<GovernedRateGateDecision>;
}

export class InMemoryGovernedRateGate implements GovernedRateGate {
  private readonly rateWindows = new Map<string, number[]>();
  private readonly grantUsage = new Map<string, number>();

  public async consume(request: GovernedRateGateRequest): Promise<GovernedRateGateDecision> {
    const grantUsageKey = stableStringify({
      grantId: request.grant.grantId,
      manifestId: request.grant.manifestId,
      manifestVersion: request.grant.manifestVersion,
      issuedAt: request.grant.issuedAt,
      expiresAt: request.grant.expiresAt,
      requestBudget: request.grant.requestBudget
    });
    const usedByGrant = this.grantUsage.get(grantUsageKey) ?? 0;
    if (usedByGrant >= request.grant.requestBudget) {
      return { allowed: false, reason: "grant-budget", retryAfterMs: 0 };
    }
    const windowKey = `${request.manifest.manifestId}@${request.manifest.version}`;
    const cutoff = request.consumedAt - request.manifest.ratePolicy.windowMs;
    const active = (this.rateWindows.get(windowKey) ?? []).filter((timestamp) => timestamp > cutoff);
    if (active.length >= request.manifest.ratePolicy.maxRequests) {
      this.rateWindows.set(windowKey, active);
      return {
        allowed: false,
        reason: "provider-rate-limit",
        retryAfterMs: Math.max(1, active[0]! + request.manifest.ratePolicy.windowMs - request.consumedAt)
      };
    }
    active.push(request.consumedAt);
    this.rateWindows.set(windowKey, active);
    this.grantUsage.set(grantUsageKey, usedByGrant + 1);
    return { allowed: true, retryAfterMs: 0 };
  }
}

export interface BrokerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: BrokerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle)
};

export interface GovernedFetchBrokerDependencies {
  readonly dns: DnsResolver;
  readonly fetch: GovernedFetchTransport;
  readonly cache?: GovernedFetchCache;
  readonly grantVerifier?: NetworkAccessGrantVerifier;
  readonly rateGate?: GovernedRateGate;
  readonly clock?: BrokerClock;
}

export type GovernedCacheMode = "default" | "reload" | "no-store";

export interface GovernedFetchRequest {
  readonly url: string;
  readonly manifest: EgressManifest;
  readonly grant: NetworkAccessGrant;
  readonly method?: GovernedHttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cacheMode?: GovernedCacheMode;
}

export interface GovernedRedirect {
  readonly status: number;
  readonly from: string;
  readonly to: string;
}

export interface GovernedFetchResponse {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly redirects: readonly GovernedRedirect[];
  readonly fromCache: boolean;
  text(): string;
  json(): unknown;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto"
]);

const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "authorization-key",
  "x-api-key"
]);

const RETAINED_RESPONSE_HEADERS = [
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "location",
  "retry-after"
] as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function responseHeaders(response: GovernedFetchTransportResponse): Readonly<Record<string, string>> {
  const retained: Record<string, string> = {};
  for (const name of RETAINED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      if (value.length > 8_192 || /[\r\n\0]/.test(value)) {
        throw new GovernedFetchError("INVALID_RESPONSE", `Response header is invalid: ${name}`);
      }
      retained[name] = value;
    }
  }
  return retained;
}

function makeResponse(entry: GovernedFetchCacheEntry, fromCache: boolean): GovernedFetchResponse {
  const body = new Uint8Array(entry.body);
  return {
    requestedUrl: entry.requestedUrl,
    finalUrl: entry.finalUrl,
    status: entry.status,
    headers: { ...entry.headers },
    body,
    redirects: entry.redirects.map((redirect) => ({ ...redirect })),
    fromCache,
    text: () => new TextDecoder("utf-8", { fatal: false }).decode(body),
    json: () => {
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
      } catch (error) {
        throw new GovernedFetchError("INVALID_JSON", "Response body is not valid UTF-8 JSON", { cause: error });
      }
    }
  };
}

function transportBody(response: import("node:http").IncomingMessage): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      for await (const rawChunk of response) {
        const chunk: unknown = rawChunk;
        if (typeof chunk === "string") yield new TextEncoder().encode(chunk);
        else if (chunk instanceof Uint8Array) yield chunk;
        else throw new GovernedFetchError("INVALID_RESPONSE", "Transport emitted a non-byte response chunk");
      }
    }
  };
}

export const pinnedNodeHttpsFetch: GovernedFetchTransport = async (input) => {
  if (input.approvedAddresses.length === 0) {
    throw new GovernedFetchError("SSRF_BLOCKED", "Transport requires at least one approved network address");
  }
  const addresses = [...input.approvedAddresses];
  const lookupPinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
      return;
    }
    const selected = addresses[0];
    if (!selected) {
      callback(new Error("No approved network address is available"), "");
      return;
    }
    callback(null, selected.address, selected.family);
  };

  return new Promise<GovernedFetchTransportResponse>((resolve, reject) => {
    const url = new URL(input.url);
    const request = httpsRequest(url, {
      method: input.method,
      headers: input.headers,
      lookup: lookupPinned,
      signal: input.signal,
      agent: false,
      servername: normalizeHostname(url.hostname)
    }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: {
          get(name: string): string | null {
            const value = response.headers[name.toLowerCase()];
            if (Array.isArray(value)) return value.join(", ");
            return value ?? null;
          }
        },
        body: transportBody(response)
      });
    });
    request.once("error", reject);
    request.end();
  });
};

interface AttemptResult {
  readonly response: GovernedFetchTransportResponse;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

function isStatusAllowed(status: number, manifest: EgressManifest): boolean {
  return manifest.responsePolicy.allowedStatusRanges.some((range) => status >= range.min && status <= range.max);
}

function normalizedContentType(value: string | undefined): string | null {
  if (!value) return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType || null;
}

function contentTypeAllowed(contentType: string, manifest: EgressManifest): boolean {
  return manifest.responsePolicy.allowedContentTypes.some((allowed) => {
    if (allowed === "*/*" || allowed === contentType) return true;
    return allowed.endsWith("/*") && contentType.startsWith(allowed.slice(0, -1));
  });
}

async function readBoundedBody(
  body: GovernedTransportBody,
  maximumBytes: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  if (body instanceof Uint8Array) {
    if (body.byteLength > maximumBytes) {
      throw new GovernedFetchError("RESPONSE_TOO_LARGE", "Response body exceeds the configured byte limit");
    }
    return new Uint8Array(body);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal.aborted) throw new GovernedFetchError("TIMEOUT", "Governed fetch timed out");
    if (!(chunk instanceof Uint8Array)) {
      throw new GovernedFetchError("INVALID_RESPONSE", "Transport emitted a non-byte response chunk");
    }
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new GovernedFetchError("RESPONSE_TOO_LARGE", "Response body exceeds the configured byte limit");
    }
    chunks.push(new Uint8Array(chunk));
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function normalizedHeaders(
  requested: Readonly<Record<string, string>> | undefined,
  manifest: EgressManifest
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(requested ?? {})) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || rawName.trim() !== rawName) {
      throw new GovernedFetchError("HEADER_NOT_AUTHORIZED", "Request contains an invalid header name");
    }
    if (result[name] !== undefined) {
      throw new GovernedFetchError("HEADER_NOT_AUTHORIZED", "Request contains duplicate header names");
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(name) || !manifest.allowedRequestHeaders.includes(name)) {
      throw new GovernedFetchError("HEADER_NOT_AUTHORIZED", `Request header is not authorized: ${name}`);
    }
    if (typeof value !== "string" || value.length > 8_192 || /[\r\n\0]/.test(value)) {
      throw new GovernedFetchError("HEADER_NOT_AUTHORIZED", "Request contains an invalid header value");
    }
    result[name] = value;
  }
  if (result["accept"] === undefined && manifest.allowedRequestHeaders.includes("accept")) {
    result["accept"] = manifest.responsePolicy.allowedContentTypes.join(", ");
  }
  return result;
}

function cacheControlTtl(headers: Readonly<Record<string, string>>, configuredTtl: number): number {
  const cacheControl = headers["cache-control"]?.toLowerCase();
  if (!cacheControl) return configuredTtl;
  if (/(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age=(\d+)/.exec(cacheControl);
  if (!match) return configuredTtl;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds)) return 0;
  return Math.min(configuredTtl, seconds * 1_000);
}

function cacheKey(
  request: GovernedFetchRequest,
  method: GovernedHttpMethod,
  headers: Readonly<Record<string, string>>
): string {
  return sha256(stableStringify({
    manifestId: request.manifest.manifestId,
    manifestVersion: request.manifest.version,
    method,
    url: new URL(request.url).toString(),
    representationHeadersHash: sha256(stableStringify(headers))
  }));
}

const DENY_ALL_GRANT_VERIFIER: NetworkAccessGrantVerifier = {
  async verify(): Promise<{ verified: false; reason: string }> {
    return { verified: false, reason: "No network access grant verifier is configured" };
  }
};

export class GovernedFetchBroker {
  private readonly cache: GovernedFetchCache;
  private readonly clock: BrokerClock;
  private readonly grantVerifier: NetworkAccessGrantVerifier;
  private readonly rateGate: GovernedRateGate;

  public constructor(private readonly dependencies: GovernedFetchBrokerDependencies) {
    this.cache = dependencies.cache ?? new MemoryGovernedFetchCache();
    this.clock = dependencies.clock ?? SYSTEM_CLOCK;
    this.grantVerifier = dependencies.grantVerifier ?? DENY_ALL_GRANT_VERIFIER;
    this.rateGate = dependencies.rateGate ?? new InMemoryGovernedRateGate();
  }

  public async fetch(request: GovernedFetchRequest): Promise<GovernedFetchResponse> {
    try {
      assertValidEgressManifest(request.manifest);
    } catch (error) {
      throw new GovernedFetchError("INVALID_MANIFEST", "Governed fetch manifest is invalid", { cause: error });
    }
    await this.verifyGrant(request.grant, request.manifest);

    const method = request.method ?? "GET";
    const headers = normalizedHeaders(request.headers, request.manifest);
    this.assertUrlAuthorized(request.url, method, request.manifest, request.grant);
    const mode = request.cacheMode ?? "default";
    const key = cacheKey(request, method, headers);
    const cacheableRequest =
      mode !== "no-store" &&
      request.manifest.cachePolicy.methods.includes(method) &&
      !Object.keys(headers).some((name) => SENSITIVE_REQUEST_HEADERS.has(name));

    if (cacheableRequest && mode === "default") {
      const cached = await this.readCache(key);
      if (cached) {
        if (
          Date.parse(cached.expiresAt) > this.clock.now() &&
          this.cachedEntryAllowed(cached, request, method, key)
        ) {
          return makeResponse(cached, true);
        }
        await this.deleteCacheEntry(key);
      }
    }

    const requestedUrl = new URL(request.url).toString();
    let currentUrl = requestedUrl;
    const redirects: GovernedRedirect[] = [];
    const visited = new Set([currentUrl]);
    let finalAttempt: AttemptResult | null = null;

    while (finalAttempt === null) {
      if (redirects.length > 0) await this.verifyGrant(request.grant, request.manifest);
      this.assertUrlAuthorized(currentUrl, method, request.manifest, request.grant);
      const attempt = await this.executeAttempt(currentUrl, method, headers, request.manifest, request.grant);
      if (!REDIRECT_STATUSES.has(attempt.response.status)) {
        finalAttempt = attempt;
        break;
      }
      if (redirects.length >= request.manifest.redirectPolicy.maxRedirects) {
        throw new GovernedFetchError("REDIRECT_LIMIT_EXCEEDED", "Response exceeded the configured redirect limit");
      }
      const location = attempt.response.headers.get("location");
      if (!location) throw new GovernedFetchError("INVALID_RESPONSE", "Redirect response is missing a Location header");
      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch (error) {
        throw new GovernedFetchError("INVALID_RESPONSE", "Redirect response contains an invalid Location header", { cause: error });
      }
      const targetUrl = target.toString();
      this.assertUrlAuthorized(targetUrl, method, request.manifest, request.grant);
      const previousHost = normalizeHostname(new URL(currentUrl).hostname);
      const targetHost = normalizeHostname(target.hostname);
      if (!request.manifest.redirectPolicy.allowCrossHost && targetHost !== previousHost) {
        throw new GovernedFetchError("REDIRECT_NOT_ALLOWED", "Cross-host redirect is disabled by the manifest");
      }
      if (
        targetHost !== previousHost &&
        Object.keys(headers).some((name) => SENSITIVE_REQUEST_HEADERS.has(name))
      ) {
        throw new GovernedFetchError("REDIRECT_NOT_ALLOWED", "Sensitive request headers cannot cross hosts");
      }
      if (visited.has(targetUrl)) throw new GovernedFetchError("REDIRECT_LOOP", "Redirect loop detected");
      redirects.push({ status: attempt.response.status, from: currentUrl, to: targetUrl });
      visited.add(targetUrl);
      currentUrl = targetUrl;
    }

    const body = finalAttempt.body ?? new Uint8Array();
    const entry: GovernedFetchCacheEntry = {
      cacheKey: key,
      manifestId: request.manifest.manifestId,
      manifestVersion: request.manifest.version,
      requestedUrl,
      finalUrl: currentUrl,
      status: finalAttempt.response.status,
      headers: finalAttempt.headers,
      body,
      bodyDigest: sha256(Buffer.from(body)),
      redirects,
      storedAt: new Date(this.clock.now()).toISOString(),
      expiresAt: new Date(this.clock.now()).toISOString()
    };

    if (cacheableRequest && entry.status >= 200 && entry.status <= 299) {
      const ttlMs = cacheControlTtl(entry.headers, request.manifest.cachePolicy.ttlMs);
      if (ttlMs > 0) {
        const cacheEntry: GovernedFetchCacheEntry = {
          ...entry,
          expiresAt: new Date(this.clock.now() + ttlMs).toISOString()
        };
        await this.writeCache(key, cacheEntry);
      }
    }
    return makeResponse(entry, false);
  }

  private async readCache(key: string): Promise<GovernedFetchCacheEntry | null> {
    try {
      return await this.cache.get(key);
    } catch (error) {
      throw new GovernedFetchError("CACHE_FAILURE", "Governed fetch cache read failed", { cause: error });
    }
  }

  private async writeCache(key: string, entry: GovernedFetchCacheEntry): Promise<void> {
    try {
      await this.cache.set(key, entry);
    } catch (error) {
      throw new GovernedFetchError("CACHE_FAILURE", "Governed fetch cache write failed", { cause: error });
    }
  }

  private async deleteCacheEntry(key: string): Promise<void> {
    try {
      await this.cache.delete(key);
    } catch (error) {
      throw new GovernedFetchError("CACHE_FAILURE", "Governed fetch cache deletion failed", { cause: error });
    }
  }

  private async verifyGrant(grant: NetworkAccessGrant, manifest: EgressManifest): Promise<void> {
    const now = new Date(this.clock.now());
    try {
      assertValidNetworkAccessGrant(grant, manifest, now);
    } catch (error) {
      throw new GovernedFetchError("INVALID_GRANT", "Network access grant is invalid or inactive", { cause: error });
    }
    let result: Awaited<ReturnType<NetworkAccessGrantVerifier["verify"]>>;
    try {
      result = await this.withTimeout(manifest.responsePolicy.timeoutMs, (signal) =>
        this.grantVerifier.verify(grant, { manifest, verifiedAt: now.toISOString() }, signal)
      );
    } catch (error) {
      if (error instanceof GovernedFetchError && error.code === "TIMEOUT") throw error;
      throw new GovernedFetchError("GRANT_VERIFICATION_FAILED", "Network access grant verification failed", {
        cause: error
      });
    }
    if (!result.verified) {
      throw new GovernedFetchError(
        "GRANT_VERIFICATION_FAILED",
        result.reason ? `Network access grant was rejected: ${result.reason}` : "Network access grant was rejected"
      );
    }
  }

  private cachedEntryAllowed(
    entry: GovernedFetchCacheEntry,
    request: GovernedFetchRequest,
    method: GovernedHttpMethod,
    expectedCacheKey: string
  ): boolean {
    try {
      if (
        !(entry.body instanceof Uint8Array) ||
        !Array.isArray(entry.redirects) ||
        typeof entry.headers !== "object" ||
        entry.headers === null ||
        entry.cacheKey !== expectedCacheKey ||
        entry.manifestId !== request.manifest.manifestId ||
        entry.manifestVersion !== request.manifest.version ||
        entry.requestedUrl !== new URL(request.url).toString() ||
        entry.redirects.length > request.manifest.redirectPolicy.maxRedirects ||
        !Number.isFinite(Date.parse(entry.storedAt)) ||
        !Number.isFinite(Date.parse(entry.expiresAt)) ||
        Date.parse(entry.expiresAt) <= Date.parse(entry.storedAt) ||
        !/^sha256:[a-f0-9]{64}$/.test(entry.bodyDigest) ||
        entry.bodyDigest !== sha256(Buffer.from(entry.body))
      ) return false;
      for (const [name, value] of Object.entries(entry.headers)) {
        if (!(RETAINED_RESPONSE_HEADERS as readonly string[]).includes(name)) return false;
        if (typeof value !== "string" || value.length > 8_192 || /[\r\n\0]/.test(value)) return false;
      }
      let expectedUrl = entry.requestedUrl;
      for (const redirect of entry.redirects) {
        if (
          !REDIRECT_STATUSES.has(redirect.status) ||
          redirect.from !== expectedUrl
        ) return false;
        this.assertUrlAuthorized(redirect.from, method, request.manifest, request.grant);
        this.assertUrlAuthorized(redirect.to, method, request.manifest, request.grant);
        const fromHost = normalizeHostname(new URL(redirect.from).hostname);
        const toHost = normalizeHostname(new URL(redirect.to).hostname);
        if (!request.manifest.redirectPolicy.allowCrossHost && fromHost !== toHost) return false;
        expectedUrl = redirect.to;
      }
      if (entry.finalUrl !== expectedUrl) return false;
      this.assertUrlAuthorized(entry.finalUrl, method, request.manifest, request.grant);
      if (!isStatusAllowed(entry.status, request.manifest)) return false;
      if (entry.body.byteLength > request.manifest.responsePolicy.maxBodyBytes) return false;
      const contentType = normalizedContentType(entry.headers["content-type"]);
      if (contentType && !contentTypeAllowed(contentType, request.manifest)) return false;
      return !(request.manifest.responsePolicy.requireContentType && entry.body.byteLength > 0 && !contentType);
    } catch {
      return false;
    }
  }

  private assertUrlAuthorized(
    url: string,
    method: GovernedHttpMethod,
    manifest: EgressManifest,
    grant: NetworkAccessGrant
  ): void {
    const result = validateUrlAuthorization(url, method, manifest, grant);
    if (!result.valid) {
      throw new GovernedFetchError("URL_NOT_AUTHORIZED", `Request URL is not authorized: ${result.errors.join("; ")}`);
    }
  }

  private async executeAttempt(
    url: string,
    method: GovernedHttpMethod,
    headers: Readonly<Record<string, string>>,
    manifest: EgressManifest,
    grant: NetworkAccessGrant
  ): Promise<AttemptResult> {
    try {
      return await this.withTimeout(manifest.responsePolicy.timeoutMs, async (signal) => {
        const rateDecision = await this.rateGate.consume({
          manifest,
          grant,
          consumedAt: this.clock.now()
        });
        if (!rateDecision.allowed) {
          if (rateDecision.reason === "grant-budget") {
            throw new GovernedFetchError("GRANT_BUDGET_EXHAUSTED", "Network access grant request budget is exhausted");
          }
          throw new GovernedFetchError("RATE_LIMITED", "Provider request rate limit is exhausted");
        }
        const addresses = await this.resolveApprovedAddresses(new URL(url).hostname, signal);
        if (signal.aborted) throw new GovernedFetchError("TIMEOUT", "Governed fetch timed out");
        const response = await this.dependencies.fetch({
          url,
          method,
          headers,
          signal,
          redirect: "manual",
          approvedAddresses: addresses
        });
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
          throw new GovernedFetchError("INVALID_RESPONSE", "Transport returned an invalid HTTP status");
        }
        const retainedHeaders = responseHeaders(response);
        const isRedirect = REDIRECT_STATUSES.has(response.status);
        if (!isRedirect && !isStatusAllowed(response.status, manifest)) {
          throw new GovernedFetchError("STATUS_NOT_ALLOWED", "Response status is outside the manifest policy");
        }
        const contentEncoding = retainedHeaders["content-encoding"]?.trim().toLowerCase();
        if (contentEncoding && contentEncoding !== "identity") {
          throw new GovernedFetchError("CONTENT_ENCODING_NOT_ALLOWED", "Compressed responses are not accepted by this broker");
        }
        const contentLengthText = retainedHeaders["content-length"];
        let contentLength: number | null = null;
        if (contentLengthText !== undefined) {
          if (!/^\d+$/.test(contentLengthText)) {
            throw new GovernedFetchError("INVALID_RESPONSE", "Response Content-Length is invalid");
          }
          contentLength = Number(contentLengthText);
          if (!Number.isSafeInteger(contentLength)) {
            throw new GovernedFetchError("INVALID_RESPONSE", "Response Content-Length is not safely representable");
          }
          if (contentLength > manifest.responsePolicy.maxBodyBytes) {
            throw new GovernedFetchError("RESPONSE_TOO_LARGE", "Response Content-Length exceeds the configured byte limit");
          }
        }
        const noBodyExpected = method === "HEAD" || response.status === 204 || response.status === 304;
        const contentType = normalizedContentType(retainedHeaders["content-type"]);
        if (contentType && !contentTypeAllowed(contentType, manifest)) {
          throw new GovernedFetchError("CONTENT_TYPE_NOT_ALLOWED", "Response Content-Type is outside the manifest policy");
        }
        if (
          !contentType &&
          manifest.responsePolicy.requireContentType &&
          !noBodyExpected &&
          contentLength !== null &&
          contentLength > 0
        ) {
          throw new GovernedFetchError("CONTENT_TYPE_NOT_ALLOWED", "Response Content-Type is required by the manifest");
        }
        const body = noBodyExpected
          ? new Uint8Array()
          : await readBoundedBody(response.body, manifest.responsePolicy.maxBodyBytes, signal);
        if (contentLength !== null && !noBodyExpected && body.byteLength !== contentLength) {
          throw new GovernedFetchError("INVALID_RESPONSE", "Response body length does not match Content-Length");
        }
        if (!contentType && manifest.responsePolicy.requireContentType && body.byteLength > 0) {
          throw new GovernedFetchError("CONTENT_TYPE_NOT_ALLOWED", "Non-empty response is missing Content-Type");
        }
        return { response, headers: retainedHeaders, body: isRedirect ? null : body };
      });
    } catch (error) {
      if (error instanceof GovernedFetchError) throw error;
      throw new GovernedFetchError("TRANSPORT_FAILURE", "Governed fetch transport failed", { cause: error });
    }
  }

  private async resolveApprovedAddresses(
    hostname: string,
    signal: AbortSignal
  ): Promise<readonly ResolvedAddress[]> {
    const normalized = normalizeHostname(hostname);
    const literalFamily = isIP(normalized);
    if (literalFamily === 4 || literalFamily === 6) {
      try {
        return validateResolvedAddresses([{ address: normalized, family: literalFamily }]);
      } catch (error) {
        throw new GovernedFetchError("SSRF_BLOCKED", "Request target is not a public network address", { cause: error });
      }
    }
    let resolved: readonly ResolvedAddress[];
    try {
      resolved = await this.dependencies.dns.resolve(normalized, signal);
    } catch (error) {
      throw new GovernedFetchError("DNS_FAILURE", "DNS resolution failed", { cause: error });
    }
    try {
      return validateResolvedAddresses(resolved);
    } catch (error) {
      throw new GovernedFetchError("SSRF_BLOCKED", "DNS resolution did not produce an exclusively public address set", { cause: error });
    }
  }

  private async withTimeout<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      const handle = this.clock.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new GovernedFetchError("TIMEOUT", "Governed fetch timed out"));
      }, timeoutMs);
      timeoutHandle = handle;
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      if (timedOut && !(error instanceof GovernedFetchError && error.code === "TIMEOUT")) {
        throw new GovernedFetchError("TIMEOUT", "Governed fetch timed out", { cause: error });
      }
      throw error;
    } finally {
      if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle);
      if (!controller.signal.aborted) controller.abort();
    }
  }
}

export function createDefaultGovernedFetchBroker(
  grantVerifier: NetworkAccessGrantVerifier,
  cache?: EncryptedGovernedFetchCache,
  rateGate?: GovernedRateGate
): GovernedFetchBroker {
  return new GovernedFetchBroker({
    dns: new NodeDnsResolver(),
    fetch: pinnedNodeHttpsFetch,
    grantVerifier,
    ...(cache ? { cache } : {}),
    ...(rateGate ? { rateGate } : {})
  });
}
