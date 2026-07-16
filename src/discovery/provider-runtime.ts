import { isIP } from "node:net";
import { sha256 } from "../hash.js";
import {
  GovernedFetchError,
  type GovernedCacheMode,
  type GovernedFetchBroker,
  type GovernedFetchResponse
} from "./governed-fetch-broker.js";
import {
  assertValidEgressManifest,
  hostMatchesPattern,
  normalizeHostname,
  type EgressManifest,
  type NetworkAccessGrant
} from "./governance.js";
import { assessSourceLiveness, type LivenessAssessment } from "./liveness.js";
import {
  providerAdapterById,
  type ProviderParseResult
} from "./provider-adapters.js";
import {
  providerManifestById,
  type DiscoveryProviderId
} from "./providers.js";
import {
  createSourceObservation,
  type ObservedSourceField,
  type SourceAvailability,
  type SourceObservation
} from "./source-observation.js";

export interface ProviderRuntimeClock {
  now(): Date;
}

export interface GovernedProviderDiscoveryRequest {
  readonly providerId: DiscoveryProviderId;
  readonly sourceKey: string;
  readonly url: string;
  readonly grant: NetworkAccessGrant;
  readonly companyHint?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cacheMode?: GovernedCacheMode;
  readonly operatorScopedTarget?: boolean;
}

export interface GovernedProviderDiscoveryResult {
  readonly providerId: DiscoveryProviderId;
  readonly manifest: EgressManifest;
  readonly response: GovernedFetchResponse | null;
  readonly parseResult: ProviderParseResult | null;
  readonly observation: SourceObservation;
  readonly liveness: LivenessAssessment;
}

const SYSTEM_CLOCK: ProviderRuntimeClock = { now: () => new Date() };

function canonicalNow(clock: ProviderRuntimeClock): string {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Provider runtime clock is invalid");
  return now.toISOString();
}

function canonicalTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provider target URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.hostname.endsWith(".")) {
    throw new Error("Provider target URL must be credential-free HTTPS without a fragment or trailing dot");
  }
  return url;
}

export function buildOperatorScopedEgressManifest(
  providerId: DiscoveryProviderId,
  targetUrl: string
): EgressManifest {
  const provider = providerManifestById(providerId);
  if (!provider.allowOperatorScopedEgress) {
    throw new Error(`Provider does not allow operator scoped egress: ${providerId}`);
  }
  const target = canonicalTarget(targetUrl);
  const hostname = normalizeHostname(target.hostname);
  if (isIP(hostname) !== 0 || !hostname.includes(".")) {
    throw new Error("Operator scoped targets require a DNS hostname");
  }
  if (
    providerId === "workday" &&
    !provider.egress.allowedHosts.some((pattern) => hostMatchesPattern(hostname, pattern))
  ) {
    throw new Error("Workday operator scope must target a public myworkdayjobs.com tenant");
  }
  const manifest: EgressManifest = {
    ...provider.egress,
    allowedHosts: [hostname],
    allowedPathPrefixes: [target.pathname || "/"],
    redirectPolicy: {
      maxRedirects: provider.egress.redirectPolicy.maxRedirects,
      allowCrossHost: false
    }
  };
  assertValidEgressManifest(manifest);
  return Object.freeze(manifest);
}

function availabilityForResponse(status: number): SourceAvailability {
  if (status >= 200 && status <= 299) return "available";
  if (status === 404) return "not-found";
  if (status === 410) return "gone";
  if (status === 401 || status === 403) return "access-denied";
  if (status === 429) return "rate-limited";
  return "uncertain";
}

function availabilityForBrokerError(error: GovernedFetchError): SourceAvailability {
  if (error.code === "RATE_LIMITED" || error.code === "GRANT_BUDGET_EXHAUSTED") return "rate-limited";
  if ([
    "INVALID_GRANT",
    "GRANT_VERIFICATION_FAILED",
    "URL_NOT_AUTHORIZED",
    "HEADER_NOT_AUTHORIZED",
    "SSRF_BLOCKED",
    "REDIRECT_NOT_ALLOWED",
    "REDIRECT_LIMIT_EXCEEDED",
    "REDIRECT_LOOP"
  ].includes(error.code)) return "access-denied";
  if (["DNS_FAILURE", "TIMEOUT", "TRANSPORT_FAILURE", "CACHE_FAILURE"].includes(error.code)) {
    return "transport-error";
  }
  return "uncertain";
}

function responseFields(parseResult: ProviderParseResult): readonly ObservedSourceField[] {
  return Object.freeze([
    {
      field: "postingCount",
      value: parseResult.postings.length,
      confidence: "high" as const,
      evidencePointer: "$adapter.postings.length"
    },
    {
      field: "rejectionCount",
      value: parseResult.rejections.length,
      confidence: parseResult.rejections.length === 0 ? "high" as const : "medium" as const,
      evidencePointer: "$adapter.rejections.length"
    }
  ]);
}

export class GovernedProviderRuntime {
  private readonly governedFetch: GovernedFetchBroker["fetch"];

  public constructor(
    broker: GovernedFetchBroker,
    private readonly clock: ProviderRuntimeClock = SYSTEM_CLOCK
  ) {
    this.governedFetch = broker.fetch.bind(broker);
  }

  public async discover(request: GovernedProviderDiscoveryRequest): Promise<GovernedProviderDiscoveryResult> {
    canonicalTarget(request.url);
    const provider = providerManifestById(request.providerId);
    const adapter = providerAdapterById(request.providerId);
    const manifest = request.operatorScopedTarget
      ? buildOperatorScopedEgressManifest(request.providerId, request.url)
      : provider.egress;
    const observedAt = canonicalNow(this.clock);
    let response: GovernedFetchResponse;
    try {
      response = await this.governedFetch({
        url: request.url,
        manifest,
        grant: request.grant,
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.cacheMode ? { cacheMode: request.cacheMode } : {})
      });
    } catch (error) {
      if (!(error instanceof GovernedFetchError)) throw error;
      const availability = availabilityForBrokerError(error);
      const observation = createSourceObservation({
        providerId: request.providerId,
        providerManifestVersion: manifest.version,
        sourceKey: request.sourceKey,
        requestedUrl: request.url,
        finalUrl: null,
        observedAt,
        availability,
        httpStatus: null,
        contentType: null,
        bodyDigest: null,
        cacheState: request.cacheMode === "no-store" ? "bypass" : "miss",
        redirectCount: 0,
        fields: [],
        uncertainty: [`Governed fetch failed with ${error.code}`]
      });
      return this.result(request.providerId, manifest, null, null, observation, observedAt);
    }

    const availability = availabilityForResponse(response.status);
    const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    const base = {
      providerId: request.providerId,
      providerManifestVersion: manifest.version,
      sourceKey: request.sourceKey,
      requestedUrl: request.url,
      finalUrl: response.finalUrl,
      observedAt,
      httpStatus: response.status,
      contentType,
      bodyDigest: sha256(Buffer.from(response.body)),
      cacheState: response.fromCache ? "hit" as const : request.cacheMode === "no-store" ? "bypass" as const : "miss" as const,
      redirectCount: response.redirects.length
    };
    if (availability !== "available") {
      const observation = createSourceObservation({
        ...base,
        availability,
        fields: [],
        uncertainty: [`HTTP ${response.status} cannot establish source availability`]
      });
      return this.result(request.providerId, manifest, response, null, observation, observedAt);
    }

    let parseResult: ProviderParseResult;
    try {
      if (contentType === null) throw new Error("Provider response has no parser content type");
      parseResult = adapter.parse({
        sourceUrl: request.url,
        finalUrl: response.finalUrl,
        contentType,
        body: response.body,
        capturedAt: observedAt,
        companyHint: request.companyHint ?? null
      });
      if (
        parseResult.postings.length === 0 &&
        (adapter.requiresAtLeastOnePosting || parseResult.rejections.length > 0)
      ) {
        throw new Error("Provider parser produced no valid postings");
      }
    } catch {
      const observation = createSourceObservation({
        ...base,
        availability: "parse-error",
        fields: [],
        uncertainty: ["The governed response could not be parsed into a valid provider contract"]
      });
      return this.result(request.providerId, manifest, response, null, observation, observedAt);
    }
    const observation = createSourceObservation({
      ...base,
      availability: "available",
      fields: responseFields(parseResult),
      uncertainty: parseResult.rejections.length === 0
        ? []
        : [`${parseResult.rejections.length} provider records were rejected without asserting their fields`]
    });
    return this.result(request.providerId, manifest, response, parseResult, observation, observedAt);
  }

  private result(
    providerId: DiscoveryProviderId,
    manifest: EgressManifest,
    response: GovernedFetchResponse | null,
    parseResult: ProviderParseResult | null,
    observation: SourceObservation,
    observedAt: string
  ): GovernedProviderDiscoveryResult {
    return Object.freeze({
      providerId,
      manifest,
      response,
      parseResult,
      observation,
      liveness: assessSourceLiveness([observation], undefined, new Date(observedAt))
    });
  }
}
