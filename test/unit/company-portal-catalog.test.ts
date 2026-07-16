import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CATALOG_PATH = resolve(ROOT, "catalog/v1/company-portals.json");
const UNRESOLVED_PATH = resolve(ROOT, "catalog/v1/unresolved-company-portals.json");
const REPORT_PATH = resolve(ROOT, "catalog/v1/verification-report.json");
const SCHEMA_PATH = resolve(ROOT, "schemas/company-portal-catalog.schema.json");
const REQUIRED_PACKS = [
  "ai",
  "clinical",
  "academic",
  "education",
  "health",
  "product",
  "startup",
  "fellowship",
  "public",
  "international-institution"
] as const;

type PackId = typeof REQUIRED_PACKS[number];

interface VerificationRun {
  readonly id: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly method: string;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
}

interface DiscoveryProvenance {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly officialWebsiteUrl: string;
  readonly sourceLicense: string | null;
  readonly sourceRevision: string | null;
  readonly retrievedAt: string;
}

interface VerificationProvenance {
  readonly method: string;
  readonly outcome: string;
  readonly checkedAt: string;
  readonly statusCode: number | null;
  readonly finalUrl: string | null;
  readonly redirectChain: readonly string[];
  readonly identity: { readonly kind: string; readonly matchedValue: string } | null;
  readonly careerSignal: { readonly kind: string; readonly matchedValue: string } | null;
  readonly responseBytes: number;
  readonly responseSha256: string | null;
  readonly failureCode?: string;
  readonly reason?: string;
}

interface PortalOrganization {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly sectors: readonly string[];
  readonly countriesOrRegions: readonly string[];
  readonly sourcePackId: PackId;
  readonly officialCareersUrl: string;
  readonly providerHint: string | null;
  readonly remoteSignal: string;
  readonly healthState: "verified" | "unresolved";
  readonly lastVerifiedAt: string | null;
  readonly provenance: {
    readonly discovery: DiscoveryProvenance;
    readonly verification: VerificationProvenance;
  };
}

interface CatalogCounts {
  readonly attempted: number;
  readonly verified: number;
  readonly unresolved: number;
  readonly bySourcePack: Readonly<Record<PackId, number>>;
}

interface CompanyPortalCatalog {
  readonly catalogVersion: string;
  readonly publishedAt: string;
  readonly verificationRun: VerificationRun;
  readonly counts: CatalogCounts;
  readonly sourcePacks: readonly {
    readonly id: PackId;
    readonly name: string;
    readonly minimumVerified: number;
    readonly verifiedCount: number;
  }[];
  readonly organizations: readonly PortalOrganization[];
}

interface UnresolvedCatalog {
  readonly catalogVersion: string;
  readonly publishedAt: string;
  readonly verificationRun: VerificationRun;
  readonly count: number;
  readonly organizations: readonly PortalOrganization[];
}

interface VerificationReport {
  readonly catalogVersion: string;
  readonly publishedAt: string;
  readonly verificationRun: VerificationRun;
  readonly counts: CatalogCounts;
  readonly failureReasons: Readonly<Record<string, number>>;
  readonly catalogSha256: string;
  readonly unresolvedSha256: string;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function canonicalHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`Not credential-free HTTPS: ${value}`);
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "referrer"].includes(normalized)) {
      url.searchParams.delete(key);
    }
  }
  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, itemValue] of sorted) {
    url.searchParams.append(key, itemValue);
  }
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  return url.toString();
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("versioned company portal catalog", () => {
  let catalog: CompanyPortalCatalog;
  let unresolved: UnresolvedCatalog;
  let report: VerificationReport;
  let schema: Record<string, unknown>;

  beforeAll(async () => {
    [catalog, unresolved, report, schema] = await Promise.all([
      loadJson<CompanyPortalCatalog>(CATALOG_PATH),
      loadJson<UnresolvedCatalog>(UNRESOLVED_PATH),
      loadJson<VerificationReport>(REPORT_PATH),
      loadJson<Record<string, unknown>>(SCHEMA_PATH)
    ]);
  });

  it("passes the strict schema and rejects unsupported or unverified data", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const formatModule = addFormatsModule as unknown as { readonly default?: (instance: Ajv) => void };
    const addFormats = formatModule.default ?? (addFormatsModule as unknown as (instance: Ajv) => void);
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(catalog), JSON.stringify(validate.errors)).toBe(true);

    const extraProperty = structuredClone(catalog) as CompanyPortalCatalog;
    (extraProperty.organizations[0]! as unknown as Record<string, unknown>).unsupported = true;
    expect(validate(extraProperty)).toBe(false);

    const unconfirmed = structuredClone(catalog) as CompanyPortalCatalog;
    (unconfirmed.organizations[0]!.provenance.verification as unknown as Record<string, unknown>).outcome = "unresolved";
    expect(validate(unconfirmed)).toBe(false);

    const redirectOnly = structuredClone(catalog) as CompanyPortalCatalog;
    (redirectOnly.organizations[0]!.provenance.verification as unknown as Record<string, unknown>).statusCode = 302;
    expect(validate(redirectOnly)).toBe(false);

    const bodyOnlyIdentity = structuredClone(catalog) as CompanyPortalCatalog;
    (bodyOnlyIdentity.organizations[0]!.provenance.verification.identity as unknown as Record<string, unknown>).kind = "page-content";
    expect(validate(bodyOnlyIdentity)).toBe(false);
  });

  it("passes the standalone offline checker", () => {
    const output = execFileSync(process.execPath, ["scripts/catalog-check.mjs", "--json"], {
      cwd: ROOT,
      encoding: "utf8"
    });
    const result = JSON.parse(output) as { readonly ok: boolean; readonly failures: readonly string[]; readonly counts: CatalogCounts };
    expect(result.ok, result.failures.join("\n")).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.counts).toEqual(catalog.counts);
  });

  it("rejects digest-consistent duplicate URL sabotage", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "vocation-catalog-adversarial-"));
    try {
      const sabotaged = structuredClone(catalog) as CompanyPortalCatalog;
      const source = sabotaged.organizations[0]!;
      const target = sabotaged.organizations[1]!;
      (target as unknown as Record<string, unknown>).officialCareersUrl = source.officialCareersUrl;
      (target as unknown as Record<string, unknown>).providerHint = source.providerHint;
      (target.provenance.verification as unknown as Record<string, unknown>).finalUrl = source.officialCareersUrl;
      const catalogBytes = Buffer.from(`${JSON.stringify(sabotaged, null, 2)}\n`, "utf8");
      const sabotagedReport = structuredClone(report) as VerificationReport;
      (sabotagedReport as unknown as Record<string, unknown>).catalogSha256 = createHash("sha256").update(catalogBytes).digest("hex");
      const catalogPath = join(temporaryDirectory, "company-portals.json");
      const reportPath = join(temporaryDirectory, "verification-report.json");
      await writeFile(catalogPath, catalogBytes);
      await writeFile(reportPath, `${JSON.stringify(sabotagedReport, null, 2)}\n`, "utf8");

      const probe = spawnSync(process.execPath, [
        "scripts/catalog-check.mjs",
        "--json",
        "--catalog",
        catalogPath,
        "--unresolved",
        UNRESOLVED_PATH,
        "--report",
        reportPath
      ], { cwd: ROOT, encoding: "utf8" });
      expect(probe.status).toBe(1);
      const result = JSON.parse(probe.stdout) as { readonly ok: boolean; readonly failures: readonly string[] };
      expect(result.ok).toBe(false);
      expect(result.failures).toContain("verified career URLs are not unique");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("has at least 250 independently verified organizations and truthful counts", () => {
    expect(catalog.organizations.length).toBeGreaterThanOrEqual(250);
    expect(catalog.counts.verified).toBe(catalog.organizations.length);
    expect(catalog.counts.unresolved).toBe(unresolved.organizations.length);
    expect(unresolved.count).toBe(unresolved.organizations.length);
    expect(catalog.counts.attempted).toBe(catalog.organizations.length + unresolved.organizations.length);
    expect(report.counts).toEqual(catalog.counts);
    expect(Object.values(report.failureReasons).reduce((sum, count) => sum + count, 0)).toBe(unresolved.count);
    expect(unresolved.organizations.every((organization) => organization.healthState === "unresolved" && organization.lastVerifiedAt === null)).toBe(true);
  });

  it("does not count duplicate organizations, IDs, or career URLs", () => {
    const all = [...catalog.organizations, ...unresolved.organizations];
    const ids = all.map((organization) => organization.organizationId);
    const names = all.map((organization) => normalizeName(organization.organizationName));
    const verifiedUrls = catalog.organizations.map((organization) => organization.officialCareersUrl);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(verifiedUrls).size).toBe(verifiedUrls.length);
  });

  it("covers every required source pack with truthful nonoverlapping counts", () => {
    expect(new Set(catalog.sourcePacks.map((pack) => pack.id))).toEqual(new Set(REQUIRED_PACKS));
    let total = 0;
    for (const packId of REQUIRED_PACKS) {
      const actual = catalog.organizations.filter((organization) => organization.sourcePackId === packId).length;
      const metadata = catalog.sourcePacks.find((pack) => pack.id === packId);
      expect(metadata).toBeDefined();
      expect(actual).toBeGreaterThanOrEqual(metadata?.minimumVerified ?? Number.POSITIVE_INFINITY);
      expect(actual).toBeGreaterThanOrEqual(5);
      expect(metadata?.verifiedCount).toBe(actual);
      expect(catalog.counts.bySourcePack[packId]).toBe(actual);
      total += actual;
    }
    expect(total).toBe(catalog.organizations.length);
  });

  it("uses canonical credential-free HTTPS URLs", () => {
    for (const organization of [...catalog.organizations, ...unresolved.organizations]) {
      const urls = [
        organization.officialCareersUrl,
        organization.provenance.discovery.sourceUrl,
        organization.provenance.discovery.officialWebsiteUrl,
        ...organization.provenance.verification.redirectChain
      ];
      if (organization.provenance.verification.finalUrl !== null) {
        urls.push(organization.provenance.verification.finalUrl);
      }
      for (const url of urls) {
        expect(url).toBe(canonicalHttpsUrl(url));
      }
    }
  });

  it("bounds publication, run, discovery, and verification timestamps", () => {
    const runStart = Date.parse(catalog.verificationRun.startedAt);
    const runEnd = Date.parse(catalog.verificationRun.completedAt);
    const publishedAt = Date.parse(catalog.publishedAt);
    expect(runStart).toBeLessThanOrEqual(runEnd);
    expect(runEnd - runStart).toBeLessThanOrEqual(3 * 60 * 60 * 1000);
    expect(runEnd).toBeLessThanOrEqual(publishedAt);
    expect(publishedAt - runEnd).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(publishedAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    expect(unresolved.publishedAt).toBe(catalog.publishedAt);
    expect(unresolved.verificationRun).toEqual(catalog.verificationRun);

    for (const organization of [...catalog.organizations, ...unresolved.organizations]) {
      const checkedAt = Date.parse(organization.provenance.verification.checkedAt);
      const retrievedAt = Date.parse(organization.provenance.discovery.retrievedAt);
      expect(checkedAt).toBeGreaterThanOrEqual(runStart);
      expect(checkedAt).toBeLessThanOrEqual(runEnd);
      expect(retrievedAt).toBeLessThanOrEqual(checkedAt);
    }
  });

  it("counts only successful identity-aware live verifications", () => {
    for (const organization of catalog.organizations) {
      const verification = organization.provenance.verification;
      expect(organization.healthState).toBe("verified");
      expect(organization.lastVerifiedAt).toBe(verification.checkedAt);
      expect(organization.officialCareersUrl).toBe(verification.finalUrl);
      expect(verification.method).toBe("bounded-https-identity-v1");
      expect(verification.outcome).toBe("identity-confirmed");
      expect(verification.statusCode).toBeGreaterThanOrEqual(200);
      expect(verification.statusCode).toBeLessThanOrEqual(299);
      expect(verification.identity?.matchedValue.length).toBeGreaterThanOrEqual(2);
      expect(verification.careerSignal?.matchedValue.length).toBeGreaterThanOrEqual(2);
      expect(verification.responseBytes).toBeGreaterThan(0);
      expect(verification.responseBytes).toBeLessThanOrEqual(catalog.verificationRun.maxResponseBytes);
      expect(verification.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
    }

    for (const organization of unresolved.organizations) {
      const verification = organization.provenance.verification;
      expect(verification.outcome).not.toBe("identity-confirmed");
      expect(verification.failureCode).toBeTruthy();
      expect(verification.reason).toBeTruthy();
    }
  });
});
