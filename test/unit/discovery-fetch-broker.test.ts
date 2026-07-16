import { describe, expect, it, vi } from "vitest";
import {
  createDefaultGovernedFetchBroker,
  GovernedFetchBroker,
  GovernedFetchError,
  MemoryGovernedFetchCache,
  pinnedNodeHttpsFetch,
  type BrokerClock,
  type GovernedFetchCacheEntry,
  type GovernedFetchTransport,
  type GovernedFetchTransportResponse,
  type TransportHeaders
} from "../../src/discovery/governed-fetch-broker.js";
import type { EgressManifest, NetworkAccessGrant } from "../../src/discovery/governance.js";
import type { NetworkAccessGrantVerifier } from "../../src/discovery/governance.js";
import type { DnsResolver, ResolvedAddress } from "../../src/discovery/ip-policy.js";

const NOW_MS = Date.parse("2026-07-14T10:00:00.000Z");
const EMPTY_JSON_DIGEST = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

const clock: BrokerClock = {
  now: () => NOW_MS,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle)
};

function manifest(overrides: Partial<EgressManifest> = {}): EgressManifest {
  return {
    manifestId: "egress:test-provider",
    providerId: "test-provider",
    version: "1.0.0",
    allowedHosts: ["public.example.com", "redirect.example.com"],
    allowedPorts: [443],
    allowedPathPrefixes: ["/"],
    allowedMethods: ["GET", "HEAD"],
    allowedRequestHeaders: ["accept"],
    redirectPolicy: { maxRedirects: 3, allowCrossHost: true },
    responsePolicy: {
      allowedStatusRanges: [{ min: 200, max: 299 }, { min: 404, max: 404 }, { min: 410, max: 410 }],
      allowedContentTypes: ["application/json"],
      requireContentType: true,
      maxBodyBytes: 1024,
      timeoutMs: 100
    },
    ratePolicy: { maxRequests: 10, windowMs: 60_000 },
    cachePolicy: { ttlMs: 60_000, methods: ["GET", "HEAD"] },
    grantPolicy: { maxTtlMs: 3_600_000, maxRequests: 20, requireExactHosts: true },
    ...overrides
  };
}

function grant(overrides: Partial<NetworkAccessGrant> = {}): NetworkAccessGrant {
  return {
    grantId: "NAG-TEST-GRANT-0002",
    subject: "test-suite",
    purpose: "offline governed fetch test",
    providerId: "test-provider",
    manifestId: "egress:test-provider",
    manifestVersion: "1.0.0",
    issuedAt: "2026-07-14T09:55:00.000Z",
    expiresAt: "2026-07-14T10:05:00.000Z",
    allowedHosts: ["public.example.com", "redirect.example.com"],
    allowedMethods: ["GET"],
    requestBudget: 10,
    ...overrides
  };
}

function headers(values: Readonly<Record<string, string>>): TransportHeaders {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => normalized[name.toLowerCase()] ?? null };
}

function response(
  status: number,
  body: string | Uint8Array | null,
  values: Readonly<Record<string, string>> = { "content-type": "application/json" }
): GovernedFetchTransportResponse {
  return {
    status,
    headers: headers(values),
    body: typeof body === "string" ? new TextEncoder().encode(body) : body
  };
}

function dnsWith(
  resolver: (hostname: string) => readonly ResolvedAddress[] | Promise<readonly ResolvedAddress[]>
): DnsResolver {
  return { resolve: async (hostname) => resolver(hostname) };
}

const PUBLIC_ADDRESS: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const VERIFIED_GRANT: NetworkAccessGrantVerifier = {
  async verify() {
    return { verified: true };
  }
};

function errorCode(error: unknown): string | undefined {
  return error instanceof GovernedFetchError ? error.code : undefined;
}

describe("GovernedFetchBroker", () => {
  it("blocks private and mixed DNS answers before transport invocation", async () => {
    const transport = vi.fn<GovernedFetchTransport>();
    const privateBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [{ address: "127.0.0.1", family: 4 }]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(privateBroker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SSRF_BLOCKED");

    const mixedBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS, { address: "10.0.0.7", family: 4 }]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(mixedBroker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SSRF_BLOCKED");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS URLs before DNS or transport", async () => {
    const resolve = vi.fn(async (_hostname: string, _signal?: AbortSignal) => [PUBLIC_ADDRESS]);
    const transport = vi.fn<GovernedFetchTransport>();
    const broker = new GovernedFetchBroker({ dns: { resolve }, fetch: transport, grantVerifier: VERIFIED_GRANT, clock });
    await expect(broker.fetch({
      url: "http://public.example.com/jobs",
      manifest: manifest(),
      grant: grant()
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "URL_NOT_AUTHORIZED");
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("revalidates authorization and DNS at every redirect hop", async () => {
    const resolve = vi.fn(async (_hostname: string, _signal?: AbortSignal) => [PUBLIC_ADDRESS]);
    const transport = vi.fn<GovernedFetchTransport>()
      .mockResolvedValueOnce(response(302, null, { location: "https://redirect.example.com/jobs/42" }))
      .mockResolvedValueOnce(response(200, "{\"id\":42}"));
    const verifier = { verify: vi.fn(async () => ({ verified: true as const })) };
    const broker = new GovernedFetchBroker({ dns: { resolve }, fetch: transport, grantVerifier: verifier, clock });
    const result = await broker.fetch({
      url: "https://public.example.com/jobs/42",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    });
    expect(result.json()).toEqual({ id: 42 });
    expect(result.redirects).toEqual([
      {
        status: 302,
        from: "https://public.example.com/jobs/42",
        to: "https://redirect.example.com/jobs/42"
      }
    ]);
    expect(resolve.mock.calls.map(([hostname]) => hostname)).toEqual(["public.example.com", "redirect.example.com"]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect whose DNS answer changes to a private address", async () => {
    const transport = vi.fn<GovernedFetchTransport>()
      .mockResolvedValueOnce(response(302, null, { location: "https://redirect.example.com/jobs/42" }));
    const broker = new GovernedFetchBroker({
      dns: dnsWith((hostname) => hostname === "public.example.com"
        ? [PUBLIC_ADDRESS]
        : [{ address: "169.254.169.254", family: 4 }]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(broker.fetch({
      url: "https://public.example.com/jobs/42",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SSRF_BLOCKED");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("enforces content type and streamed body size gates", async () => {
    const wrongTypeBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, "html", { "content-type": "text/html" }),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(wrongTypeBroker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "CONTENT_TYPE_NOT_ALLOWED");

    const oversizedBody: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(700);
        yield new Uint8Array(700);
      }
    };
    const oversizedBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => ({ status: 200, headers: headers({ "content-type": "application/json" }), body: oversizedBody }),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(oversizedBroker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "RESPONSE_TOO_LARGE");
  });

  it("aborts transports that exceed the manifest timeout", async () => {
    const transport: GovernedFetchTransport = async (request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const broker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    const timeoutManifest = manifest({
      responsePolicy: { ...manifest().responsePolicy, timeoutMs: 5 }
    });
    await expect(broker.fetch({
      url: "https://public.example.com/jobs",
      manifest: timeoutManifest,
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "TIMEOUT");
  });

  it("uses cache without consuming another request and rate limits uncached egress", async () => {
    const transport = vi.fn<GovernedFetchTransport>().mockResolvedValue(response(200, "{\"ok\":true}"));
    const cacheBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: transport,
      cache: new MemoryGovernedFetchCache(),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    const request = { url: "https://public.example.com/jobs", manifest: manifest(), grant: grant() } as const;
    expect((await cacheBroker.fetch(request)).fromCache).toBe(false);
    expect((await cacheBroker.fetch(request)).fromCache).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);

    const rateManifest = manifest({ ratePolicy: { maxRequests: 1, windowMs: 60_000 } });
    const rateBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await rateBroker.fetch({ ...request, manifest: rateManifest, cacheMode: "no-store" });
    await expect(rateBroker.fetch({ ...request, manifest: rateManifest, cacheMode: "no-store" }))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "RATE_LIMITED");
  });

  it("normalizes cache backend failures at the typed broker boundary", async () => {
    const transport = vi.fn<GovernedFetchTransport>().mockResolvedValue(response(200, "{\"ok\":true}"));
    const readFailureBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      cache: {
        async get() { throw new Error("cache unavailable"); },
        async set() {},
        async delete() {}
      },
      clock
    });
    const request = { url: "https://public.example.com/jobs", manifest: manifest(), grant: grant() } as const;
    await expect(readFailureBroker.fetch(request))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "CACHE_FAILURE");
    expect(transport).not.toHaveBeenCalled();

    const writeFailureBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      cache: {
        async get() { return null; },
        async set() { throw new Error("cache unavailable"); },
        async delete() {}
      },
      clock
    });
    await expect(writeFailureBroker.fetch(request))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "CACHE_FAILURE");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("enforces malformed status, encoding, length, and content metadata gates", async () => {
    const cases: ReadonlyArray<{
      readonly transportResponse: GovernedFetchTransportResponse;
      readonly expectedCode: string;
    }> = [
      { transportResponse: response(99, "{}"), expectedCode: "INVALID_RESPONSE" },
      { transportResponse: response(500, "{}"), expectedCode: "STATUS_NOT_ALLOWED" },
      {
        transportResponse: response(200, "{}", {
          "content-type": "application/json",
          "content-encoding": "gzip"
        }),
        expectedCode: "CONTENT_ENCODING_NOT_ALLOWED"
      },
      {
        transportResponse: response(200, "{}", {
          "content-type": "application/json",
          "content-length": "not-a-number"
        }),
        expectedCode: "INVALID_RESPONSE"
      },
      {
        transportResponse: response(200, "{}", {
          "content-type": "application/json",
          "content-length": "2048"
        }),
        expectedCode: "RESPONSE_TOO_LARGE"
      },
      {
        transportResponse: response(200, "{}", {
          "content-type": "application/json",
          "content-length": "4"
        }),
        expectedCode: "INVALID_RESPONSE"
      },
      { transportResponse: response(200, "{}", {}), expectedCode: "CONTENT_TYPE_NOT_ALLOWED" }
    ];

    for (const testCase of cases) {
      const broker = new GovernedFetchBroker({
        dns: dnsWith(() => [PUBLIC_ADDRESS]),
        fetch: async () => testCase.transportResponse,
        grantVerifier: VERIFIED_GRANT,
        clock
      });
      await expect(broker.fetch({
        url: "https://public.example.com/jobs",
        manifest: manifest(),
        grant: grant(),
        cacheMode: "no-store"
      })).rejects.toSatisfy((error: unknown) => errorCode(error) === testCase.expectedCode);
    }
  });

  it("supports bodyless responses and exposes invalid JSON through a typed error", async () => {
    const headBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, new Uint8Array(2048), {}),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    const head = await headBroker.fetch({
      url: "https://public.example.com/jobs",
      method: "HEAD",
      manifest: manifest(),
      grant: grant({ allowedMethods: ["HEAD"] }),
      cacheMode: "no-store"
    });
    expect(head.body).toHaveLength(0);

    const jsonBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, "not json"),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    const invalidJson = await jsonBroker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    });
    expect(() => invalidJson.json()).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
  });

  it("rejects missing, malformed, looping, excessive, and disallowed redirects", async () => {
    const redirectCases: ReadonlyArray<{
      readonly location: string | null;
      readonly manifest: EgressManifest;
      readonly expectedCode: string;
    }> = [
      { location: null, manifest: manifest(), expectedCode: "INVALID_RESPONSE" },
      { location: "http://[", manifest: manifest(), expectedCode: "INVALID_RESPONSE" },
      {
        location: "https://redirect.example.com/jobs",
        manifest: manifest({ redirectPolicy: { maxRedirects: 3, allowCrossHost: false } }),
        expectedCode: "REDIRECT_NOT_ALLOWED"
      },
      {
        location: "https://public.example.com/jobs",
        manifest: manifest(),
        expectedCode: "REDIRECT_LOOP"
      },
      {
        location: "https://redirect.example.com/jobs",
        manifest: manifest({ redirectPolicy: { maxRedirects: 0, allowCrossHost: true } }),
        expectedCode: "REDIRECT_LIMIT_EXCEEDED"
      }
    ];
    for (const testCase of redirectCases) {
      const values = testCase.location === null ? {} : { location: testCase.location };
      const broker = new GovernedFetchBroker({
        dns: dnsWith(() => [PUBLIC_ADDRESS]),
        fetch: async () => response(302, null, values),
        grantVerifier: VERIFIED_GRANT,
        clock
      });
      await expect(broker.fetch({
        url: "https://public.example.com/jobs",
        manifest: testCase.manifest,
        grant: grant(),
        cacheMode: "no-store"
      })).rejects.toSatisfy((error: unknown) => errorCode(error) === testCase.expectedCode);
    }

    const secretBroker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(302, null, { location: "https://redirect.example.com/jobs" }),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(secretBroker.fetch({
      url: "https://public.example.com/jobs",
      headers: { authorization: "redacted-test-value" },
      manifest: manifest({ allowedRequestHeaders: ["accept", "authorization"] }),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "REDIRECT_NOT_ALLOWED");
  });

  it("normalizes verifier, DNS, and transport dependency failures", async () => {
    const verifierRejected = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, "{}"),
      grantVerifier: { verify: async () => ({ verified: false, reason: "signature mismatch" }) },
      clock
    });
    await expect(verifierRejected.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant()
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "GRANT_VERIFICATION_FAILED");

    const verifierFailed = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, "{}"),
      grantVerifier: { verify: async () => { throw new Error("verifier unavailable"); } },
      clock
    });
    await expect(verifierFailed.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant()
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "GRANT_VERIFICATION_FAILED");

    const dnsFailed = new GovernedFetchBroker({
      dns: { resolve: async () => { throw new Error("resolver unavailable"); } },
      fetch: async () => response(200, "{}"),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(dnsFailed.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "DNS_FAILURE");

    const transportFailed = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => { throw new Error("transport unavailable"); },
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    await expect(transportFailed.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "TRANSPORT_FAILURE");
  });

  it("enforces request header policy before DNS and transport", async () => {
    const transport = vi.fn<GovernedFetchTransport>();
    const broker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: transport,
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    for (const requestHeaders of [
      { "x-not-allowed": "value" },
      { host: "attacker.example" },
      { accept: "application/json\ninvalid" },
      { Accept: "application/json", accept: "application/json" }
    ]) {
      await expect(broker.fetch({
        url: "https://public.example.com/jobs",
        headers: requestHeaders,
        manifest: manifest(),
        grant: grant()
      })).rejects.toSatisfy((error: unknown) => errorCode(error) === "HEADER_NOT_AUTHORIZED");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("enforces grant request budgets independently from provider rate windows", async () => {
    const broker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, "{}"),
      grantVerifier: VERIFIED_GRANT,
      clock
    });
    const oneRequestGrant = grant({ requestBudget: 1 });
    const request = {
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: oneRequestGrant,
      cacheMode: "no-store" as const
    };
    await broker.fetch(request);
    await expect(broker.fetch(request))
      .rejects.toSatisfy((error: unknown) => errorCode(error) === "GRANT_BUDGET_EXHAUSTED");
  });

  it("fails closed when an expired cache entry cannot be deleted", async () => {
    const staleEntry = (key: string): GovernedFetchCacheEntry => ({
      cacheKey: key,
      manifestId: "egress:test-provider",
      manifestVersion: "1.0.0",
      requestedUrl: "https://public.example.com/jobs",
      finalUrl: "https://public.example.com/jobs",
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      bodyDigest: EMPTY_JSON_DIGEST,
      redirects: [],
      storedAt: "2026-07-14T08:00:00.000Z",
      expiresAt: "2026-07-14T09:00:00.000Z"
    });
    const broker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, "{}"),
      grantVerifier: VERIFIED_GRANT,
      cache: {
        async get(key) { return staleEntry(key); },
        async set() {},
        async delete() { throw new Error("cache unavailable"); }
      },
      clock
    });
    await expect(broker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant()
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "CACHE_FAILURE");
  });

  it("rejects a cache entry whose body no longer matches its integrity digest", async () => {
    const deleteEntry = vi.fn(async (_key: string) => {});
    const broker = new GovernedFetchBroker({
      dns: dnsWith(() => [PUBLIC_ADDRESS]),
      fetch: async () => response(200, "{\"fresh\":true}"),
      grantVerifier: VERIFIED_GRANT,
      cache: {
        async get(key) {
          return {
            cacheKey: key,
            manifestId: "egress:test-provider",
            manifestVersion: "1.0.0",
            requestedUrl: "https://public.example.com/jobs",
            finalUrl: "https://public.example.com/jobs",
            status: 200,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode("{\"poisoned\":true}"),
            bodyDigest: EMPTY_JSON_DIGEST,
            redirects: [],
            storedAt: "2026-07-14T09:59:00.000Z",
            expiresAt: "2026-07-14T10:01:00.000Z"
          };
        },
        async set() {},
        delete: deleteEntry
      },
      clock
    });
    const result = await broker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant()
    });
    expect(result.fromCache).toBe(false);
    expect(result.json()).toEqual({ fresh: true });
    expect(deleteEntry).toHaveBeenCalledTimes(1);
  });

  it("exposes safe default and in-memory cache primitives without network access", async () => {
    expect(createDefaultGovernedFetchBroker(VERIFIED_GRANT)).toBeInstanceOf(GovernedFetchBroker);
    const controller = new AbortController();
    await expect(pinnedNodeHttpsFetch({
      url: "https://public.example.com/jobs",
      method: "GET",
      headers: {},
      signal: controller.signal,
      redirect: "manual",
      approvedAddresses: []
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SSRF_BLOCKED");

    const cache = new MemoryGovernedFetchCache();
    const entry: GovernedFetchCacheEntry = {
      cacheKey: "cache-key",
      manifestId: "egress:test-provider",
      manifestVersion: "1.0.0",
      requestedUrl: "https://public.example.com/jobs",
      finalUrl: "https://public.example.com/jobs",
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      bodyDigest: EMPTY_JSON_DIGEST,
      redirects: [],
      storedAt: "2026-07-14T10:00:00.000Z",
      expiresAt: "2026-07-14T10:01:00.000Z"
    };
    await cache.set("cache-key", entry);
    await cache.delete("cache-key");
    expect(await cache.get("cache-key")).toBeNull();
  });

  it("fails closed when no grant verifier is configured", async () => {
    const transport = vi.fn<GovernedFetchTransport>();
    const broker = new GovernedFetchBroker({ dns: dnsWith(() => [PUBLIC_ADDRESS]), fetch: transport, clock });
    await expect(broker.fetch({
      url: "https://public.example.com/jobs",
      manifest: manifest(),
      grant: grant(),
      cacheMode: "no-store"
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "GRANT_VERIFICATION_FAILED");
    expect(transport).not.toHaveBeenCalled();
  });
});
