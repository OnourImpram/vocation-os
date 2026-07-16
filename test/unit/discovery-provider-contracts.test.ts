import { describe, expect, it } from "vitest";
import {
  GovernedFetchBroker,
  type BrokerClock
} from "../../src/discovery/governed-fetch-broker.js";
import type { NetworkAccessGrant } from "../../src/discovery/governance.js";
import {
  DISCOVERY_PROVIDER_ADAPTERS,
  MANDATORY_PROVIDER_ADAPTERS,
  providerAdapterById,
  type ProviderParseInput
} from "../../src/discovery/provider-adapters.js";
import {
  GovernedProviderRuntime,
  buildOperatorScopedEgressManifest
} from "../../src/discovery/provider-runtime.js";
import {
  CONTRACT_TESTED_GA_PROVIDER_COUNT,
  DISCOVERY_PROVIDER_SUPPORT_REPORT,
  assertGaProviderCountClaim
} from "../../src/discovery/provider-support.js";
import {
  DISCOVERY_PROVIDER_MANIFESTS,
  MANDATORY_PROVIDER_IDS,
  MANDATORY_PROVIDER_MANIFESTS,
  REQUIRED_DISCOVERY_PROVIDER_IDS,
  type DiscoveryProviderId
} from "../../src/discovery/providers.js";

interface ProviderFixture {
  readonly contentType: string;
  readonly body: string;
}

const CAPTURED_AT = "2026-07-14T10:00:00.000Z";
const NOW_MS = Date.parse(CAPTURED_AT);
const BROKER_CLOCK: BrokerClock = {
  now: () => NOW_MS,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle)
};

function posting(providerId: string): Readonly<Record<string, unknown>> {
  return {
    id: `${providerId}-record-1`,
    title: "Clinical AI Researcher",
    company: "Example Research",
    url: `https://jobs.example.test/${providerId}/record-1`,
    description: "<p>Build governed discovery systems.</p>",
    location: "Remote",
    publishedAt: "2026-07-14T08:00:00.000Z"
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const FIXTURES: Readonly<Record<string, ProviderFixture>> = Object.freeze({
  greenhouse: { contentType: "application/json", body: json({ jobs: [posting("greenhouse")] }) },
  lever: { contentType: "application/json", body: json([posting("lever")]) },
  ashby: { contentType: "application/json", body: json({ jobs: [posting("ashby")] }) },
  workable: {
    contentType: "text/html",
    body: `<html><script type="application/ld+json">${json({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      identifier: { value: "workable-record-1" },
      title: "Clinical AI Researcher",
      hiringOrganization: { name: "Example Research" },
      url: "https://jobs.example.test/workable/record-1",
      description: "<p>Build governed discovery systems.</p>",
      jobLocationType: "TELECOMMUTE",
      datePosted: "2026-07-14T08:00:00.000Z"
    })}</script></html>`
  },
  workday: { contentType: "application/json", body: json({ jobPostings: [posting("workday")] }) },
  smartrecruiters: { contentType: "application/json", body: json({ content: [posting("smartrecruiters")] }) },
  teamtailor: {
    contentType: "application/json",
    body: json({ data: [{ id: "teamtailor-record-1", attributes: posting("teamtailor") }] })
  },
  bamboohr: { contentType: "application/json", body: json({ jobs: [posting("bamboohr")] }) },
  "breezy-hr": { contentType: "application/json", body: json({ positions: [posting("breezy-hr")] }) },
  recruitee: { contentType: "application/json", body: json({ offers: [posting("recruitee")] }) },
  personio: {
    contentType: "application/xml",
    body: [
      "<workzag-jobs><position>",
      "<id>personio-record-1</id>",
      "<name>Clinical AI Researcher</name>",
      "<office>Remote</office>",
      "<description>Build governed discovery systems.</description>",
      "<startDate>2026-07-14T08:00:00.000Z</startDate>",
      "</position></workzag-jobs>"
    ].join("")
  },
  "schema-org-job-posting": {
    contentType: "text/html",
    body: `<html><script type="application/ld+json">${json({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      identifier: { value: "schema-record-1" },
      title: "Clinical AI Researcher",
      hiringOrganization: { name: "Example Research" },
      url: "https://jobs.example.test/schema/record-1",
      description: "<p>Build governed discovery systems.</p>",
      jobLocationType: "TELECOMMUTE",
      datePosted: "2026-07-14T08:00:00.000Z"
    })}</script></html>`
  }
});

function input(fixture: ProviderFixture): ProviderParseInput {
  return {
    sourceUrl: "https://source.example.test/jobs",
    finalUrl: "https://source.example.test/jobs",
    contentType: fixture.contentType,
    body: new TextEncoder().encode(fixture.body),
    capturedAt: CAPTURED_AT,
    companyHint: "Example Research"
  };
}

function fixtureFor(providerId: DiscoveryProviderId): ProviderFixture {
  return FIXTURES[providerId] ?? {
    contentType: "application/json",
    body: json({ jobs: [posting(providerId)] })
  };
}

describe("discovery provider contracts", () => {
  it("binds exactly 12 executable adapters to the mandatory provider manifests", () => {
    expect(MANDATORY_PROVIDER_ADAPTERS).toHaveLength(12);
    expect(MANDATORY_PROVIDER_MANIFESTS).toHaveLength(12);
    expect(new Set(MANDATORY_PROVIDER_ADAPTERS.map((adapter) => adapter.providerId)))
      .toEqual(new Set(MANDATORY_PROVIDER_IDS));
    expect(MANDATORY_PROVIDER_MANIFESTS.every((manifest) =>
      manifest.contractTestReceipt?.suite === "test/unit/discovery-provider-contracts.test.ts"
    )).toBe(true);
  });

  it("binds all 36 provider manifests to executable adapters", () => {
    expect(DISCOVERY_PROVIDER_ADAPTERS).toHaveLength(36);
    expect(DISCOVERY_PROVIDER_MANIFESTS).toHaveLength(36);
    expect(new Set(DISCOVERY_PROVIDER_ADAPTERS.map((adapter) => adapter.providerId)))
      .toEqual(new Set(REQUIRED_DISCOVERY_PROVIDER_IDS));
  });

  it.each(DISCOVERY_PROVIDER_ADAPTERS)("parses a deterministic $providerId contract fixture", (adapter) => {
    const fixture = fixtureFor(adapter.providerId);
    const first = adapter.parse(input(fixture));
    const second = adapter.parse(input(fixture));

    expect(second).toEqual(first);
    expect(first.providerId).toBe(adapter.providerId);
    expect(first.contractVersion).toBe("1.0.0");
    expect(first.rejections).toEqual([]);
    expect(first.postings).toHaveLength(1);
    expect(first.postings[0]).toMatchObject({
      providerId: adapter.providerId,
      company: "Example Research",
      roleTitle: "Clinical AI Researcher",
      capturedAt: CAPTURED_AT
    });
    expect(first.postings[0]?.postingId).toMatch(/^DISC-[A-F0-9]{32}$/);
    expect(first.postings[0]?.sourcePayloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("isolates duplicate and invalid provider records without a false posting", () => {
    const adapter = providerAdapterById("greenhouse");
    const valid = posting("greenhouse");
    const result = adapter.parse(input({
      contentType: "application/json",
      body: json({ jobs: [valid, valid, { id: "invalid", company: "Example Research" }] })
    }));
    expect(result.postings).toHaveLength(1);
    expect(result.rejections.map((rejection) => rejection.code)).toEqual([
      "duplicate-record",
      "invalid-record"
    ]);
  });

  it("rejects unsafe XML declarations and unsupported parser media types", () => {
    const personio = providerAdapterById("personio");
    expect(() => personio.parse(input({
      contentType: "application/xml",
      body: "<!DOCTYPE positions><positions />"
    }))).toThrow(/declarations and entities are not permitted/);

    const greenhouse = providerAdapterById("greenhouse");
    expect(() => greenhouse.parse(input({ contentType: "application/pdf", body: "%PDF" })))
      .toThrow(/Unsupported greenhouse parser content type/);

    const schemaOrg = providerAdapterById("schema-org-job-posting");
    expect(() => schemaOrg.parse({
      ...input(FIXTURES["schema-org-job-posting"]!),
      body: new Uint8Array(8 * 1024 * 1024 + 1)
    })).toThrow(/exceeds 8 MiB/);
  });

  it("reports only executable, receipt-bound adapters as contract-tested GA", () => {
    expect(CONTRACT_TESTED_GA_PROVIDER_COUNT).toBe(36);
    expect(DISCOVERY_PROVIDER_SUPPORT_REPORT).toMatchObject({
      manifestCount: 36,
      executableAdapterCount: 36,
      contractTestedGaCount: 36,
      manifestOnlyCount: 0,
      assistOnlyCount: 0,
      invalidGaProviderIds: [],
      all36ContractTestedGa: true
    });
    expect(assertGaProviderCountClaim(36)).toEqual(DISCOVERY_PROVIDER_SUPPORT_REPORT);
  });

  it("narrows operator scoped egress to one DNS host and target path", () => {
    const manifest = buildOperatorScopedEgressManifest(
      "schema-org-job-posting",
      "https://careers.example.test/jobs/clinical-ai"
    );
    expect(manifest.allowedHosts).toEqual(["careers.example.test"]);
    expect(manifest.allowedPathPrefixes).toEqual(["/jobs/clinical-ai"]);
    expect(manifest.redirectPolicy.allowCrossHost).toBe(false);

    expect(() => buildOperatorScopedEgressManifest(
      "schema-org-job-posting",
      "https://127.0.0.1/jobs"
    )).toThrow(/DNS hostname/);
    expect(() => buildOperatorScopedEgressManifest(
      "greenhouse" as DiscoveryProviderId,
      "https://careers.example.test/jobs"
    )).toThrow(/does not allow operator scoped egress/);
    expect(() => buildOperatorScopedEgressManifest(
      "workday",
      "https://careers.example.test/jobs"
    )).toThrow(/myworkdayjobs.com tenant/);
  });

  it("runs provider discovery through the governed broker without live network access", async () => {
    const fixture = FIXTURES["greenhouse"]!;
    const url = "https://boards-api.greenhouse.io/v1/boards/example/jobs";
    const grant: NetworkAccessGrant = {
      grantId: "NAG-PROVIDER-RUNTIME-0001",
      subject: "provider-contract-suite",
      purpose: "offline provider runtime verification",
      providerId: "greenhouse",
      manifestId: "egress:greenhouse",
      manifestVersion: "1.0.0",
      issuedAt: "2026-07-14T09:55:00.000Z",
      expiresAt: "2026-07-14T10:05:00.000Z",
      allowedHosts: ["boards-api.greenhouse.io"],
      allowedMethods: ["GET"],
      requestBudget: 2
    };
    const successBroker = new GovernedFetchBroker({
      dns: { resolve: async () => [{ address: "93.184.216.34", family: 4 }] },
      fetch: async () => ({
        status: 200,
        headers: {
          get: (name) => name.toLowerCase() === "content-type" ? fixture.contentType : null
        },
        body: new TextEncoder().encode(fixture.body)
      }),
      grantVerifier: { verify: async () => ({ verified: true }) },
      clock: BROKER_CLOCK
    });
    const successRuntime = new GovernedProviderRuntime(
      successBroker,
      { now: () => new Date(NOW_MS) }
    );
    const success = await successRuntime.discover({
      providerId: "greenhouse",
      sourceKey: "greenhouse:example",
      url,
      grant,
      companyHint: "Example Research",
      cacheMode: "no-store"
    });
    expect(success.parseResult?.postings).toHaveLength(1);
    expect(success.observation.availability).toBe("available");
    expect(success.liveness.state).toBe("live");

    const blockedBroker = new GovernedFetchBroker({
      dns: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
      fetch: async () => { throw new Error("transport must not be reached"); },
      grantVerifier: { verify: async () => ({ verified: true }) },
      clock: BROKER_CLOCK
    });
    const blockedRuntime = new GovernedProviderRuntime(
      blockedBroker,
      { now: () => new Date(NOW_MS) }
    );
    const blocked = await blockedRuntime.discover({
      providerId: "greenhouse",
      sourceKey: "greenhouse:example",
      url,
      grant,
      cacheMode: "no-store"
    });
    expect(blocked.response).toBeNull();
    expect(blocked.observation.availability).toBe("access-denied");
    expect(blocked.observation.uncertainty).toEqual(["Governed fetch failed with SSRF_BLOCKED"]);
    expect(blocked.liveness.state).toBe("unreachable");
  });

  it.each([
    {
      providerId: "workday" as const,
      url: "https://example.myworkdayjobs.com/en-US/careers/jobs",
      host: "example.myworkdayjobs.com",
      fixture: FIXTURES["workday"]!
    },
    {
      providerId: "schema-org-job-posting" as const,
      url: "https://careers.example.test/jobs/clinical-ai",
      host: "careers.example.test",
      fixture: FIXTURES["schema-org-job-posting"]!
    }
  ])("executes $providerId through an operator scoped governed broker path", async ({
    providerId,
    url,
    host,
    fixture
  }) => {
    const grant: NetworkAccessGrant = {
      grantId: providerId === "workday"
        ? "NAG-WORKDAY-RUNTIME-0001"
        : "NAG-SCHEMA-RUNTIME-0001",
      subject: "provider-contract-suite",
      purpose: "offline operator scoped provider verification",
      providerId,
      manifestId: `egress:${providerId}`,
      manifestVersion: "1.0.0",
      issuedAt: "2026-07-14T09:55:00.000Z",
      expiresAt: "2026-07-14T10:05:00.000Z",
      allowedHosts: [host],
      allowedMethods: ["GET"],
      requestBudget: 2
    };
    const broker = new GovernedFetchBroker({
      dns: { resolve: async () => [{ address: "93.184.216.34", family: 4 }] },
      fetch: async () => ({
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "content-type" ? fixture.contentType : null },
        body: new TextEncoder().encode(fixture.body)
      }),
      grantVerifier: { verify: async () => ({ verified: true }) },
      clock: BROKER_CLOCK
    });
    const runtime = new GovernedProviderRuntime(broker, { now: () => new Date(NOW_MS) });
    const result = await runtime.discover({
      providerId,
      sourceKey: `${providerId}:operator-fixture`,
      url,
      grant,
      companyHint: "Example Research",
      cacheMode: "no-store",
      operatorScopedTarget: true
    });
    expect(result.manifest.allowedHosts).toEqual([host]);
    expect(result.parseResult?.postings).toHaveLength(1);
    expect(result.observation.availability).toBe("available");
    expect(result.liveness.state).toBe("live");
  });
});
