import { describe, expect, it } from "vitest";
import {
  assertValidEgressManifest,
  assertValidNetworkAccessGrant,
  hostMatchesPattern,
  hostPatternIsWithin,
  isValidHostPattern,
  normalizeHostname,
  validateEgressManifest,
  validateNetworkAccessGrant,
  validateUrlAuthorization,
  type EgressManifest,
  type NetworkAccessGrant
} from "../../src/discovery/governance.js";
import {
  isPublicNetworkAddress,
  validateResolvedAddresses
} from "../../src/discovery/ip-policy.js";

const NOW = new Date("2026-07-14T10:00:00.000Z");

function manifest(overrides: Partial<EgressManifest> = {}): EgressManifest {
  return {
    manifestId: "egress:network-policy",
    providerId: "network-policy",
    version: "1.0.0",
    allowedHosts: ["api.example.com", "*.tenant.example.com"],
    allowedPorts: [443],
    allowedPathPrefixes: ["/jobs"],
    allowedMethods: ["GET", "HEAD"],
    allowedRequestHeaders: ["accept"],
    redirectPolicy: { maxRedirects: 2, allowCrossHost: true },
    responsePolicy: {
      allowedStatusRanges: [{ min: 200, max: 299 }, { min: 404, max: 404 }],
      allowedContentTypes: ["application/json"],
      requireContentType: true,
      maxBodyBytes: 1024,
      timeoutMs: 1000
    },
    ratePolicy: { maxRequests: 10, windowMs: 60_000 },
    cachePolicy: { ttlMs: 60_000, methods: ["GET"] },
    grantPolicy: { maxTtlMs: 3_600_000, maxRequests: 20, requireExactHosts: true },
    ...overrides
  };
}

function grant(overrides: Partial<NetworkAccessGrant> = {}): NetworkAccessGrant {
  return {
    grantId: "NAG-NETWORK-POLICY-0001",
    subject: "network-policy-suite",
    purpose: "offline network governance verification",
    providerId: "network-policy",
    manifestId: "egress:network-policy",
    manifestVersion: "1.0.0",
    issuedAt: "2026-07-14T09:55:00.000Z",
    expiresAt: "2026-07-14T10:05:00.000Z",
    allowedHosts: ["api.example.com", "one.tenant.example.com"],
    allowedMethods: ["GET"],
    requestBudget: 5,
    ...overrides
  };
}

describe("discovery IP policy", () => {
  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "1.1.1.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8"
  ])("accepts public address %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
  });

  it.each([
    "not-an-ip",
    "01.2.3.4",
    "0.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1"
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it("rejects empty, mismatched, or mixed DNS answers and canonicalizes public answers", () => {
    expect(() => validateResolvedAddresses([])).toThrow(/no addresses/);
    expect(() => validateResolvedAddresses([{ address: "8.8.8.8", family: 6 }])).toThrow(/address family/);
    expect(() => validateResolvedAddresses([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]))
      .toThrow(/non-public/);
    expect(validateResolvedAddresses([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.8.8", family: 4 }
    ])).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 }
    ]);
  });
});

describe("discovery governance validation edges", () => {
  it("normalizes hostnames and applies wildcard containment without matching the apex", () => {
    expect(normalizeHostname(" [2001:DB8::1] ")).toBe("2001:db8::1");
    expect(normalizeHostname("API.EXAMPLE.COM.")).toBe("api.example.com");
    expect(isValidHostPattern("2001:4860:4860::8888")).toBe(true);
    expect(isValidHostPattern("*.2001:4860:4860::8888")).toBe(false);
    expect(hostMatchesPattern("one.tenant.example.com", "*.tenant.example.com")).toBe(true);
    expect(hostMatchesPattern("tenant.example.com", "*.tenant.example.com")).toBe(false);
    expect(hostPatternIsWithin("one.deep.tenant.example.com", "*.tenant.example.com")).toBe(true);
    expect(hostPatternIsWithin("*.deep.tenant.example.com", "*.tenant.example.com")).toBe(true);
    expect(hostPatternIsWithin("*.tenant.example.com", "api.example.com")).toBe(false);
  });

  it("collects malformed manifest policy errors instead of accepting partial governance", () => {
    expect(validateEgressManifest(null)).toEqual({ valid: false, errors: ["EgressManifest must be an object"] });
    const result = validateEgressManifest({
      manifestId: "wrong",
      providerId: "INVALID PROVIDER",
      version: "latest",
      allowedHosts: ["bad..host", "api.example.com", "api.example.com"],
      allowedPorts: [0, 443, 443],
      allowedPathPrefixes: ["jobs", "/%E0%A4%A"],
      allowedMethods: ["POST"],
      allowedRequestHeaders: ["Authorization", "bad header"],
      redirectPolicy: { maxRedirects: 11, allowCrossHost: "yes" },
      responsePolicy: {
        allowedStatusRanges: [{ min: 99, max: 98 }, { min: "200", max: 299 }],
        allowedContentTypes: ["Application/JSON", "invalid"],
        requireContentType: "yes",
        maxBodyBytes: 0,
        timeoutMs: 0
      },
      ratePolicy: { maxRequests: 0, windowMs: 0 },
      cachePolicy: { ttlMs: -1, methods: ["POST"] },
      grantPolicy: { maxTtlMs: 0, maxRequests: 0, requireExactHosts: "yes" }
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "manifestId is invalid",
      "providerId is invalid",
      "version must be semantic version text",
      "allowedHosts contains an invalid entry",
      "allowedHosts must not contain duplicates",
      "allowedPorts contains an invalid entry",
      "allowedPorts must not contain duplicates",
      "redirectPolicy.maxRedirects must be an integer from 0 to 10",
      "responsePolicy.maxBodyBytes must be between 1 byte and 64 MiB",
      "grantPolicy.requireExactHosts must be boolean"
    ]));
    expect(() => assertValidEgressManifest(result)).toThrow(/EgressManifest validation failed/);
  });

  it("rejects overlapping ranges, missing policy objects, and cache methods outside request scope", () => {
    expect(validateEgressManifest(manifest({
      responsePolicy: {
        ...manifest().responsePolicy,
        allowedStatusRanges: [{ min: 200, max: 250 }, { min: 250, max: 299 }]
      },
      allowedMethods: ["GET"],
      cachePolicy: { ttlMs: 1, methods: ["HEAD"] }
    })).errors).toEqual(expect.arrayContaining([
      "responsePolicy.allowedStatusRanges must not overlap",
      "cachePolicy.methods must be a subset of allowedMethods"
    ]));
    const withoutObjects = { ...manifest() } as Record<string, unknown>;
    withoutObjects["redirectPolicy"] = null;
    withoutObjects["responsePolicy"] = null;
    withoutObjects["ratePolicy"] = null;
    withoutObjects["cachePolicy"] = null;
    withoutObjects["grantPolicy"] = null;
    expect(validateEgressManifest(withoutObjects).errors).toEqual(expect.arrayContaining([
      "redirectPolicy must be an object",
      "responsePolicy must be an object",
      "ratePolicy must be an object",
      "cachePolicy must be an object",
      "grantPolicy must be an object"
    ]));
  });

  it("rejects grants that exceed identity, host, method, budget, and time boundaries", () => {
    expect(validateNetworkAccessGrant(null, manifest(), NOW)).toEqual({
      valid: false,
      errors: ["NetworkAccessGrant must be an object"]
    });
    const result = validateNetworkAccessGrant({
      grantId: "bad",
      subject: "",
      purpose: "",
      providerId: "other",
      manifestId: "egress:other",
      manifestVersion: "2.0.0",
      issuedAt: "invalid",
      expiresAt: "invalid",
      allowedHosts: ["*.tenant.example.com", "outside.example.net"],
      allowedMethods: ["HEAD"],
      requestBudget: 21
    }, manifest(), NOW);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "grantId is invalid",
      "subject is invalid",
      "purpose is invalid",
      "providerId does not match the manifest",
      "allowedHosts must contain exact hosts for this manifest",
      "allowed host is outside the manifest boundary: outside.example.net",
      "requestBudget exceeds the manifest grant policy",
      "issuedAt must be an ISO date-time"
    ]));
    expect(() => assertValidNetworkAccessGrant(result, manifest(), NOW)).toThrow(/NetworkAccessGrant validation failed/);
  });

  it("enforces grant activation order, lifetime, and expiry", () => {
    expect(validateNetworkAccessGrant(grant({
      issuedAt: "2026-07-14T10:01:00.000Z",
      expiresAt: "2026-07-14T10:00:00.000Z"
    }), manifest(), NOW).errors).toEqual(expect.arrayContaining([
      "expiresAt must be after issuedAt",
      "grant is not active yet",
      "grant has expired"
    ]));
    expect(validateNetworkAccessGrant(grant({
      issuedAt: "2026-07-14T08:00:00.000Z",
      expiresAt: "2026-07-14T10:01:00.000Z"
    }), manifest(), NOW).errors).toContain("grant lifetime exceeds the manifest policy");
    expect(validateNetworkAccessGrant(grant(), { ...manifest(), manifestId: "invalid" }, NOW).errors[0])
      .toMatch(/^manifest:/);
  });

  it("rejects malformed URLs, credentials, fragments, ports, invalid encoding, and traversal", () => {
    expect(validateUrlAuthorization("not a URL", "GET", manifest(), grant()).errors).toEqual([
      "request URL is invalid"
    ]);
    const boundary = validateUrlAuthorization(
      "https://user:secret@api.example.com.:444/jobs/%00#fragment",
      "HEAD",
      manifest(),
      grant()
    );
    expect(boundary.errors).toEqual(expect.arrayContaining([
      "request URL must not contain embedded credentials",
      "request URL must not contain a fragment",
      "request URL must not contain a trailing dot hostname",
      "request port is outside the manifest boundary",
      "request method is not authorized",
      "request path contains a forbidden traversal segment"
    ]));
    expect(validateUrlAuthorization(
      "https://api.example.com/jobs/%E0%A4%A",
      "GET",
      manifest(),
      grant()
    ).errors).toContain("request path contains invalid percent encoding");
    expect(validateUrlAuthorization(
      "https://api.example.com/jobs/%252e%252e/admin",
      "GET",
      manifest(),
      grant()
    ).errors).toContain("request path contains a forbidden traversal segment");
    expect(validateUrlAuthorization(
      "https://api.example.com/jobs/%25252525252e",
      "GET",
      manifest(),
      grant()
    ).errors).toContain("request path contains invalid percent encoding");
  });
});
