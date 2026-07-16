export const PROVIDER_KINDS = [
  "job-board",
  "company-careers",
  "catalog",
  "search",
  "aggregator"
] as const;

export const PROVIDER_SUPPORT_LEVELS = ["discovered", "invocable", "verified"] as const;

export const PROVIDER_CAPABILITIES = [
  "discover-opportunities",
  "resolve-company",
  "health-check"
] as const;

export const REMOTE_POLICIES = ["remote-only", "remote-preferred", "any"] as const;
export const CACHE_MODES = ["default", "refresh", "bypass"] as const;
export const CACHE_RESULTS = ["hit", "miss", "revalidated", "bypassed"] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type ProviderSupportLevel = (typeof PROVIDER_SUPPORT_LEVELS)[number];
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];
export type RemotePolicy = (typeof REMOTE_POLICIES)[number];
export type CacheMode = (typeof CACHE_MODES)[number];
export type CacheResult = (typeof CACHE_RESULTS)[number];

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  version: string;
  kind: ProviderKind;
  supportLevel: ProviderSupportLevel;
  capabilities: readonly ProviderCapability[];
  baseUrls: readonly string[];
}

export interface ProviderPageRequest {
  cursor?: string;
  limit: number;
}

export interface DiscoveryQuery {
  keywords: readonly string[];
  locations: readonly string[];
  remotePolicy: RemotePolicy;
  employmentTypes?: readonly string[];
  page: ProviderPageRequest;
}

export interface ProviderProvenance {
  providerId: string;
  sourceUrl: string;
  retrievedAt: string;
  contentHash: string;
  sourceRecordId?: string;
}

export interface ProviderOpportunity {
  externalId: string;
  title: string;
  organization: string;
  canonicalUrl: string;
  location: string | null;
  remote: boolean | null;
  employmentType: string | null;
  summary: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  provenance: ProviderProvenance;
}

export interface ProviderPage<T> {
  items: readonly T[];
  requestId: string;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ProviderHealth {
  providerId: string;
  status: "healthy" | "degraded" | "unavailable";
  checkedAt: string;
  latencyMs: number;
  detail?: string;
}

export interface BrokerCachePolicy {
  mode: CacheMode;
  ttlMs: number;
}

export interface BrokerRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ProviderFetchRequest {
  providerId: string;
  requestId: string;
  url: string;
  method: "GET";
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  cache: BrokerCachePolicy;
  retry: BrokerRetryPolicy;
}

export interface ProviderFetchResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  finalUrl: string;
  fetchedAt: string;
  cacheResult: CacheResult;
  contentHash: string;
}

export interface ProviderFetchBroker {
  execute(request: ProviderFetchRequest, signal?: AbortSignal): Promise<ProviderFetchResponse>;
}

export interface ProviderExecutionContext {
  broker: ProviderFetchBroker;
  now(): Date;
  signal?: AbortSignal;
}

export interface DiscoveryProvider {
  readonly descriptor: ProviderDescriptor;
  health(context: ProviderExecutionContext): Promise<ProviderHealth>;
  discover(query: DiscoveryQuery, context: ProviderExecutionContext): Promise<ProviderPage<ProviderOpportunity>>;
}

export type ProviderErrorCode =
  | "invalid-contract"
  | "rate-limited"
  | "authentication-required"
  | "upstream-unavailable"
  | "invalid-response"
  | "cancelled";

export class ProviderContractError extends Error {
  public constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "ProviderContractError";
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ProviderContractError("invalid-contract", `${field} must not be empty`);
  }
}

function assertHttpsUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderContractError("invalid-contract", `${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ProviderContractError(
      "invalid-contract",
      `${field} must use HTTPS and must not contain credentials or a fragment`
    );
  }
}

export function defineProviderDescriptor(input: ProviderDescriptor): ProviderDescriptor {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) {
    throw new ProviderContractError(
      "invalid-contract",
      "Provider id must contain lowercase letters, numbers, and single hyphens"
    );
  }
  assertNonEmpty(input.displayName, "Provider display name");
  assertNonEmpty(input.version, "Provider version");
  if (!PROVIDER_KINDS.includes(input.kind)) {
    throw new ProviderContractError("invalid-contract", "Provider kind is invalid");
  }
  if (!PROVIDER_SUPPORT_LEVELS.includes(input.supportLevel)) {
    throw new ProviderContractError("invalid-contract", "Provider support level is invalid");
  }
  if (input.capabilities.length === 0) {
    throw new ProviderContractError("invalid-contract", "Provider must declare at least one capability");
  }
  if (input.capabilities.some((capability) => !PROVIDER_CAPABILITIES.includes(capability))) {
    throw new ProviderContractError("invalid-contract", "Provider capability is invalid");
  }
  if (new Set(input.capabilities).size !== input.capabilities.length) {
    throw new ProviderContractError("invalid-contract", "Provider capabilities must be unique");
  }
  if (input.baseUrls.length === 0) {
    throw new ProviderContractError("invalid-contract", "Provider must declare at least one base URL");
  }
  for (const [index, url] of input.baseUrls.entries()) {
    assertHttpsUrl(url, `Provider base URL ${index + 1}`);
  }
  if (new Set(input.baseUrls).size !== input.baseUrls.length) {
    throw new ProviderContractError("invalid-contract", "Provider base URLs must be unique");
  }

  return Object.freeze({
    ...input,
    capabilities: Object.freeze([...input.capabilities]),
    baseUrls: Object.freeze([...input.baseUrls])
  });
}

export function defineProviderPage<T>(input: ProviderPage<T>): ProviderPage<T> {
  assertNonEmpty(input.requestId, "Provider request id");
  if (input.hasMore && !input.nextCursor) {
    throw new ProviderContractError(
      "invalid-contract",
      "A provider page with more results must include a next cursor"
    );
  }
  if (!input.hasMore && input.nextCursor !== null) {
    throw new ProviderContractError(
      "invalid-contract",
      "A terminal provider page must not include a next cursor"
    );
  }
  return Object.freeze({ ...input, items: Object.freeze([...input.items]) });
}

export function assertSha256(value: string, field = "Content hash"): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ProviderContractError("invalid-contract", `${field} must be a lowercase SHA-256 digest`);
  }
}
