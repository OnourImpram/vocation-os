import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { describe, expect, it } from "vitest";
import {
  validateEgressManifest,
  validateNetworkAccessGrant,
  validateUrlAuthorization,
  type EgressManifest,
  type NetworkAccessGrant
} from "../../src/discovery/governance.js";
import {
  DISCOVERY_PROVIDER_MANIFESTS,
  EXPANDED_PROVIDER_MANIFESTS,
  MANDATORY_PROVIDER_MANIFESTS,
  validateProviderCatalog
} from "../../src/discovery/providers.js";

const NOW = new Date("2026-07-14T10:00:00.000Z");

function manifest(): EgressManifest {
  return {
    manifestId: "egress:test-provider",
    providerId: "test-provider",
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
    cachePolicy: { ttlMs: 60_000, methods: ["GET", "HEAD"] },
    grantPolicy: { maxTtlMs: 3_600_000, maxRequests: 20, requireExactHosts: true }
  };
}

function grant(overrides: Partial<NetworkAccessGrant> = {}): NetworkAccessGrant {
  return {
    grantId: "NAG-TEST-GRANT-0001",
    subject: "test-suite",
    purpose: "offline discovery contract test",
    providerId: "test-provider",
    manifestId: "egress:test-provider",
    manifestVersion: "1.0.0",
    issuedAt: "2026-07-14T09:55:00.000Z",
    expiresAt: "2026-07-14T10:05:00.000Z",
    allowedHosts: ["api.example.com"],
    allowedMethods: ["GET"],
    requestBudget: 5,
    ...overrides
  };
}

describe("discovery network governance", () => {
  it("validates a grant only when it is a live subset of its egress manifest", () => {
    expect(validateEgressManifest(manifest())).toEqual({ valid: true, errors: [] });
    expect(validateNetworkAccessGrant(grant(), manifest(), NOW)).toEqual({ valid: true, errors: [] });

    const invalid = validateNetworkAccessGrant(grant({
      expiresAt: "2026-07-14T09:59:00.000Z",
      allowedHosts: ["*.tenant.example.com"]
    }), manifest(), NOW);
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.errors).toEqual(expect.arrayContaining([
        "allowedHosts must contain exact hosts for this manifest",
        "grant has expired"
      ]));
    }
  });

  it("rejects non-canonical and extensible governance payloads", () => {
    expect(validateEgressManifest({ ...manifest(), unexpected: true }).valid).toBe(false);
    expect(validateEgressManifest({ ...manifest(), allowedHosts: ["API.example.com"] }).valid).toBe(false);
    expect(validateEgressManifest({
      ...manifest(),
      responsePolicy: { ...manifest().responsePolicy, allowedContentTypes: ["*/*"] }
    }).valid).toBe(false);
    expect(validateNetworkAccessGrant({ ...grant(), unexpected: true }, manifest(), NOW).valid).toBe(false);
    expect(validateNetworkAccessGrant(grant({ issuedAt: "2026-07-14T09:55:00Z" }), manifest(), NOW).valid).toBe(false);
    expect(validateNetworkAccessGrant(grant(), manifest(), new Date(Number.NaN)).valid).toBe(false);
  });

  it("enforces HTTPS, host, path, and method scope", () => {
    expect(validateUrlAuthorization("https://api.example.com/jobs/42", "GET", manifest(), grant()).valid).toBe(true);
    expect(validateUrlAuthorization("http://api.example.com/jobs/42", "GET", manifest(), grant()).valid).toBe(false);
    expect(validateUrlAuthorization("https://api.example.com/admin", "GET", manifest(), grant()).valid).toBe(false);
    expect(validateUrlAuthorization("https://other.example.com/jobs/42", "GET", manifest(), grant()).valid).toBe(false);
    expect(validateUrlAuthorization("https://api.example.com/jobs/42", "HEAD", manifest(), grant()).valid).toBe(false);
  });

  it("ships exactly 12 mandatory and 24 expanded provider manifests", () => {
    expect(MANDATORY_PROVIDER_MANIFESTS).toHaveLength(12);
    expect(EXPANDED_PROVIDER_MANIFESTS).toHaveLength(24);
    expect(DISCOVERY_PROVIDER_MANIFESTS).toHaveLength(36);
    expect(new Set(DISCOVERY_PROVIDER_MANIFESTS.map((entry) => entry.providerId))).toHaveLength(36);
    expect(validateProviderCatalog()).toEqual({ valid: true, errors: [] });
    expect(DISCOVERY_PROVIDER_MANIFESTS.filter((entry) => entry.discoveryMode === "assist-only")).toHaveLength(0);
  });

  it("compiles every owned discovery and taxonomy schema independently", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const addFormats = (addFormatsModule as unknown as { default?: (instance: Ajv) => void }).default
      ?? (addFormatsModule as unknown as (instance: Ajv) => void);
    addFormats(ajv);
    const schemaFiles = readdirSync(path.resolve("schemas"))
      .filter((filename) => /^(?:discovery|taxonomy)-.*\.json$/.test(filename))
      .sort();
    expect(schemaFiles).toContain("discovery-opportunity-truth-record.schema.json");
    expect(schemaFiles).toContain("discovery-liveness-assessment.schema.json");
    for (const filename of schemaFiles) {
      const schema = JSON.parse(readFileSync(path.resolve("schemas", filename), "utf8")) as AnySchema;
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });
});
