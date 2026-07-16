import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

export const SOURCE_PACK_IDS = Object.freeze([
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
]);

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer"
]);
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "ac.uk",
  "co.in",
  "co.jp",
  "co.nz",
  "co.uk",
  "com.au",
  "com.br",
  "com.sg",
  "com.tr",
  "edu.au",
  "edu.tr",
  "go.jp",
  "gov.au",
  "gov.tr",
  "gov.uk",
  "govt.nz",
  "ne.jp",
  "nhs.uk",
  "org.au",
  "org.uk"
]);
const PROVIDER_HOST_PATTERNS = Object.freeze([
  ["ashby", /(?:^|\.)ashbyhq\.com$/u],
  ["bamboohr", /(?:^|\.)bamboohr\.com$/u],
  ["eightfold", /(?:^|\.)(?:eightfold\.ai|eightfold\.com)$/u],
  ["greenhouse", /(?:^|\.)(?:greenhouse\.io|greenhouse\.com)$/u],
  ["icims", /(?:^|\.)icims\.com$/u],
  ["jobvite", /(?:^|\.)jobvite\.com$/u],
  ["lever", /(?:^|\.)lever\.co$/u],
  ["oracle-hcm", /(?:^|\.)(?:oraclecloud\.com|oracle\.com)$/u],
  ["pageup", /(?:^|\.)pageuppeople\.com$/u],
  ["personio", /(?:^|\.)(?:personio\.com|jobs\.personio\.de)$/u],
  ["phenom", /(?:^|\.)(?:phenompeople\.com|phenom\.com)$/u],
  ["recruitee", /(?:^|\.)recruitee\.com$/u],
  ["smartrecruiters", /(?:^|\.)smartrecruiters\.com$/u],
  ["successfactors", /(?:^|\.)successfactors\.(?:com|eu)$/u],
  ["taleo", /(?:^|\.)taleo\.net$/u],
  ["teamtailor", /(?:^|\.)teamtailor\.com$/u],
  ["workable", /(?:^|\.)workable\.com$/u],
  ["workday", /(?:^|\.)(?:myworkdayjobs\.com|workday\.com)$/u]
]);

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function invariant(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function normalizeIdentity(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function canonicalizeHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`URL must use HTTPS: ${value}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`URL must not contain credentials: ${value}`);
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, valuePart] of sorted) {
    url.searchParams.append(key, valuePart);
  }
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  return url.toString();
}

export function registrableDomain(value) {
  const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname === "localhost") {
    return hostname;
  }
  const labels = hostname.split(".");
  if (labels.length <= 2) {
    return hostname;
  }
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join(".")
    : lastTwo;
}

export function inferProvider(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return PROVIDER_HOST_PATTERNS.find(([, pattern]) => pattern.test(hostname))?.[0] ?? null;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseArgs(argv) {
  const options = {
    catalog: resolve(DEFAULT_ROOT, "catalog/v1/company-portals.json"),
    unresolved: resolve(DEFAULT_ROOT, "catalog/v1/unresolved-company-portals.json"),
    report: resolve(DEFAULT_ROOT, "catalog/v1/verification-report.json"),
    schema: resolve(DEFAULT_ROOT, "schemas/company-portal-catalog.schema.json"),
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (["--catalog", "--unresolved", "--report", "--schema"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path`);
      }
      options[argument.slice(2)] = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function readJson(path) {
  const bytes = await readFile(path);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function validateTimestampBounds(catalog, unresolved, failures) {
  const runStart = Date.parse(catalog.verificationRun.startedAt);
  const runEnd = Date.parse(catalog.verificationRun.completedAt);
  const publishedAt = Date.parse(catalog.publishedAt);
  invariant(Number.isFinite(runStart), "verificationRun.startedAt is invalid", failures);
  invariant(Number.isFinite(runEnd), "verificationRun.completedAt is invalid", failures);
  invariant(Number.isFinite(publishedAt), "publishedAt is invalid", failures);
  invariant(runStart <= runEnd, "verification run ends before it starts", failures);
  invariant(runEnd - runStart <= 3 * 60 * 60 * 1000, "verification run exceeds three hours", failures);
  invariant(runEnd <= publishedAt, "catalog was published before verification completed", failures);
  invariant(publishedAt - runEnd <= 10 * 60 * 1000, "catalog publication is more than ten minutes after verification", failures);
  invariant(publishedAt <= Date.now() + 5 * 60 * 1000, "catalog publication timestamp is in the future", failures);
  invariant(unresolved.publishedAt === catalog.publishedAt, "unresolved publication timestamp differs from catalog", failures);

  for (const organization of [...catalog.organizations, ...unresolved.organizations]) {
    const checkedAt = Date.parse(organization.provenance.verification.checkedAt);
    const retrievedAt = Date.parse(organization.provenance.discovery.retrievedAt);
    invariant(
      Number.isFinite(checkedAt) && checkedAt >= runStart && checkedAt <= runEnd,
      `${organization.organizationId} verification timestamp falls outside the run`,
      failures
    );
    invariant(
      Number.isFinite(retrievedAt) && retrievedAt <= checkedAt,
      `${organization.organizationId} discovery timestamp follows verification`,
      failures
    );
  }
}

function validateUnresolved(unresolved, catalog, failures) {
  invariant(unresolved && typeof unresolved === "object" && !Array.isArray(unresolved), "unresolved file must be an object", failures);
  invariant(unresolved.catalogVersion === catalog.catalogVersion, "unresolved catalog version differs", failures);
  invariant(JSON.stringify(unresolved.verificationRun) === JSON.stringify(catalog.verificationRun), "unresolved verification run differs", failures);
  invariant(Number.isInteger(unresolved.count) && unresolved.count >= 0, "unresolved count is invalid", failures);
  invariant(Array.isArray(unresolved.organizations), "unresolved organizations must be an array", failures);
  if (!Array.isArray(unresolved.organizations)) {
    return;
  }
  invariant(unresolved.count === unresolved.organizations.length, "unresolved count does not match entries", failures);
  for (const organization of unresolved.organizations) {
    const prefix = organization?.organizationId ?? "unknown-unresolved-entry";
    const required = [
      "organizationId",
      "organizationName",
      "sectors",
      "countriesOrRegions",
      "sourcePackId",
      "officialCareersUrl",
      "providerHint",
      "remoteSignal",
      "healthState",
      "lastVerifiedAt",
      "provenance"
    ];
    for (const key of required) {
      invariant(Object.hasOwn(organization, key), `${prefix} unresolved entry lacks ${key}`, failures);
    }
    invariant(organization.healthState === "unresolved", `${prefix} unresolved health state is not unresolved`, failures);
    invariant(organization.lastVerifiedAt === null, `${prefix} unresolved entry has a verification timestamp`, failures);
    invariant(SOURCE_PACK_IDS.includes(organization.sourcePackId), `${prefix} has an unknown source pack`, failures);
    invariant(Array.isArray(organization.sectors) && organization.sectors.length > 0, `${prefix} lacks sectors`, failures);
    invariant(Array.isArray(organization.countriesOrRegions) && organization.countriesOrRegions.length > 0, `${prefix} lacks regions`, failures);
    const verification = organization.provenance?.verification;
    invariant(verification?.method === "bounded-https-identity-v1", `${prefix} has an unknown verification method`, failures);
    invariant(verification?.outcome !== "identity-confirmed", `${prefix} unresolved entry claims confirmed identity`, failures);
    invariant(typeof verification?.reason === "string" && verification.reason.length > 0, `${prefix} lacks an unresolved reason`, failures);
  }
}

function validateEntryUrls(organizations, failures) {
  for (const organization of organizations) {
    for (const [label, value] of [
      ["officialCareersUrl", organization.officialCareersUrl],
      ["provenance.discovery.sourceUrl", organization.provenance?.discovery?.sourceUrl],
      ["provenance.discovery.officialWebsiteUrl", organization.provenance?.discovery?.officialWebsiteUrl]
    ]) {
      try {
        invariant(canonicalizeHttpsUrl(value) === value, `${organization.organizationId} ${label} is not canonical HTTPS`, failures);
      } catch (error) {
        failures.push(`${organization.organizationId} ${label}: ${error.message}`);
      }
    }
    const finalUrl = organization.provenance?.verification?.finalUrl;
    if (finalUrl !== null && finalUrl !== undefined) {
      try {
        invariant(canonicalizeHttpsUrl(finalUrl) === finalUrl, `${organization.organizationId} verification final URL is not canonical HTTPS`, failures);
      } catch (error) {
        failures.push(`${organization.organizationId} verification final URL: ${error.message}`);
      }
    }
  }
}

function validateVerifiedIdentity(organization, failures) {
  const verification = organization.provenance.verification;
  const prefix = organization.organizationId;
  invariant(organization.lastVerifiedAt === verification.checkedAt, `${prefix} lastVerifiedAt does not match checkedAt`, failures);
  invariant(organization.officialCareersUrl === verification.finalUrl, `${prefix} careers URL differs from verified final URL`, failures);
  invariant(verification.statusCode >= 200 && verification.statusCode <= 299, `${prefix} has a non-success verification status`, failures);
  invariant(verification.outcome === "identity-confirmed", `${prefix} lacks confirmed identity`, failures);
  invariant(verification.responseSha256 !== "0".repeat(64), `${prefix} has an empty response digest`, failures);
  invariant(typeof verification.careerSignal?.matchedValue === "string", `${prefix} lacks a career-page signal`, failures);
  invariant(inferProvider(organization.officialCareersUrl) === organization.providerHint, `${prefix} provider hint does not match the final host`, failures);

  const identity = verification.identity;
  if (identity.kind === "official-domain") {
    invariant(
      registrableDomain(organization.provenance.discovery.officialWebsiteUrl) === registrableDomain(verification.finalUrl),
      `${prefix} official-domain evidence does not preserve the organization domain`,
      failures
    );
    invariant(identity.matchedValue === registrableDomain(verification.finalUrl), `${prefix} official-domain evidence value is incorrect`, failures);
    return;
  }

  const normalizedName = normalizeIdentity(organization.organizationName);
  const normalizedMatch = normalizeIdentity(identity.matchedValue);
  invariant(normalizedMatch.length >= 2 && normalizedName.includes(normalizedMatch), `${prefix} identity evidence is not derived from the organization name`, failures);
  if (identity.kind === "ats-tenant-and-page") {
    invariant(organization.providerHint !== null, `${prefix} ATS evidence has no provider hint`, failures);
  }
}

export async function checkCatalog(options = {}) {
  const paths = {
    catalog: options.catalog ?? resolve(DEFAULT_ROOT, "catalog/v1/company-portals.json"),
    unresolved: options.unresolved ?? resolve(DEFAULT_ROOT, "catalog/v1/unresolved-company-portals.json"),
    report: options.report ?? resolve(DEFAULT_ROOT, "catalog/v1/verification-report.json"),
    schema: options.schema ?? resolve(DEFAULT_ROOT, "schemas/company-portal-catalog.schema.json")
  };
  const failures = [];
  const [catalogFile, unresolvedFile, reportFile, schemaFile] = await Promise.all([
    readJson(paths.catalog),
    readJson(paths.unresolved),
    readJson(paths.report),
    readJson(paths.schema)
  ]);
  const catalog = catalogFile.value;
  const unresolved = unresolvedFile.value;
  const report = reportFile.value;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schemaFile.value);
  if (!validate(catalog)) {
    for (const error of validate.errors ?? []) {
      failures.push(`schema ${error.instancePath || "/"} ${error.message}`);
    }
  }

  validateUnresolved(unresolved, catalog, failures);
  const verified = Array.isArray(catalog.organizations) ? catalog.organizations : [];
  const pending = Array.isArray(unresolved.organizations) ? unresolved.organizations : [];
  const all = [...verified, ...pending];
  invariant(verified.length >= 250, `verified count ${verified.length} is below 250`, failures);
  invariant(catalog.counts?.verified === verified.length, "catalog verified count is not truthful", failures);
  invariant(catalog.counts?.unresolved === pending.length, "catalog unresolved count is not truthful", failures);
  invariant(catalog.counts?.attempted === all.length, "catalog attempted count is not truthful", failures);
  invariant(catalog.counts?.attempted === catalog.counts?.verified + catalog.counts?.unresolved, "attempted count does not equal verified plus unresolved", failures);

  const ids = all.map((entry) => entry.organizationId);
  const names = all.map((entry) => normalizeIdentity(entry.organizationName));
  const verifiedUrls = verified.map((entry) => entry.officialCareersUrl);
  const unresolvedUrls = pending.map((entry) => entry.officialCareersUrl);
  invariant(new Set(ids).size === ids.length, "organization IDs are not unique across verified and unresolved entries", failures);
  invariant(new Set(names).size === names.length, "organization names are not unique across verified and unresolved entries", failures);
  invariant(new Set(verifiedUrls).size === verifiedUrls.length, "verified career URLs are not unique", failures);
  invariant(new Set(unresolvedUrls).size === unresolvedUrls.length, "unresolved career URLs are not unique", failures);
  const verifiedIds = verified.map((entry) => entry.organizationId);
  const unresolvedIds = pending.map((entry) => entry.organizationId);
  invariant(JSON.stringify(verifiedIds) === JSON.stringify([...verifiedIds].sort()), "verified catalog entries are not sorted by organization ID", failures);
  invariant(JSON.stringify(unresolvedIds) === JSON.stringify([...unresolvedIds].sort()), "unresolved catalog entries are not sorted by organization ID", failures);

  const packCounts = Object.fromEntries(SOURCE_PACK_IDS.map((id) => [id, verified.filter((entry) => entry.sourcePackId === id).length]));
  for (const id of SOURCE_PACK_IDS) {
    invariant(packCounts[id] >= 5, `${id} source pack has fewer than five verified organizations`, failures);
    invariant(catalog.counts?.bySourcePack?.[id] === packCounts[id], `${id} count is not truthful`, failures);
    const metadata = catalog.sourcePacks?.find((pack) => pack.id === id);
    invariant(metadata !== undefined, `${id} source pack metadata is missing`, failures);
    invariant(metadata?.verifiedCount === packCounts[id], `${id} source pack metadata count is not truthful`, failures);
    invariant(packCounts[id] >= (metadata?.minimumVerified ?? Number.POSITIVE_INFINITY), `${id} source pack misses its declared minimum`, failures);
  }
  invariant(new Set(catalog.sourcePacks?.map((pack) => pack.id)).size === SOURCE_PACK_IDS.length, "source pack metadata IDs are duplicated or incomplete", failures);
  invariant(Object.values(packCounts).reduce((sum, count) => sum + count, 0) === verified.length, "source pack counts do not sum to verified entries", failures);

  validateEntryUrls(all, failures);
  for (const organization of verified) {
    validateVerifiedIdentity(organization, failures);
  }
  validateTimestampBounds(catalog, unresolved, failures);

  invariant(report.catalogVersion === catalog.catalogVersion, "verification report catalog version differs", failures);
  invariant(report.publishedAt === catalog.publishedAt, "verification report publication timestamp differs", failures);
  invariant(JSON.stringify(report.verificationRun) === JSON.stringify(catalog.verificationRun), "verification report run differs", failures);
  invariant(JSON.stringify(report.counts) === JSON.stringify(catalog.counts), "verification report counts differ", failures);
  invariant(report.catalogSha256 === sha256(catalogFile.bytes), "verification report catalog digest is incorrect", failures);
  invariant(report.unresolvedSha256 === sha256(unresolvedFile.bytes), "verification report unresolved digest is incorrect", failures);
  const reasonTotal = Object.values(report.failureReasons ?? {}).reduce((sum, count) => sum + count, 0);
  invariant(reasonTotal === pending.length, "verification report failure reasons do not sum to unresolved entries", failures);

  return {
    ok: failures.length === 0,
    counts: {
      attempted: all.length,
      verified: verified.length,
      unresolved: pending.length,
      bySourcePack: packCounts
    },
    failures
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await checkCatalog(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Catalog check passed: ${result.counts.verified} verified, ${result.counts.unresolved} unresolved.\n`);
  } else {
    process.stderr.write(`Catalog check failed with ${result.failures.length} issue(s):\n`);
    for (const failure of result.failures) {
      process.stderr.write(`  ${failure}\n`);
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
