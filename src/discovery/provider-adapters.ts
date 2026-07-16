import { sha256, stableStringify } from "../hash.js";
import {
  DISCOVERY_PROVIDER_MANIFESTS,
  MANDATORY_PROVIDER_IDS,
  REQUIRED_DISCOVERY_PROVIDER_IDS,
  type DiscoveryProviderId
} from "./providers.js";

export interface ProviderParseInput {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly capturedAt: string;
  readonly companyHint: string | null;
}

export interface DiscoveredProviderPosting {
  readonly postingId: string;
  readonly providerId: DiscoveryProviderId;
  readonly sourceRecordId: string;
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly applyUrl: string | null;
  readonly company: string;
  readonly roleTitle: string;
  readonly location: string;
  readonly descriptionText: string;
  readonly postedAt: string | null;
  readonly deadline: string | null;
  readonly capturedAt: string;
  readonly sourcePayloadHash: string;
}

export interface ProviderParseRejection {
  readonly recordIndex: number;
  readonly code: "invalid-record" | "duplicate-record";
  readonly message: string;
}

export interface ProviderParseResult {
  readonly providerId: DiscoveryProviderId;
  readonly contractVersion: "1.0.0";
  readonly postings: readonly DiscoveredProviderPosting[];
  readonly rejections: readonly ProviderParseRejection[];
}

export interface DiscoveryProviderAdapter {
  readonly providerId: DiscoveryProviderId;
  readonly contractVersion: "1.0.0";
  readonly executable: true;
  readonly requiresAtLeastOnePosting: boolean;
  readonly supportedContentTypes: readonly string[];
  parse(input: ProviderParseInput): ProviderParseResult;
}

type JsonRecord = Record<string, unknown>;

interface AdapterDefinition {
  readonly providerId: DiscoveryProviderId;
  readonly roots: readonly (readonly string[])[];
  readonly supportedContentTypes: readonly string[];
  readonly requiresAtLeastOnePosting?: boolean;
}

interface XmlElement {
  readonly name: string;
  readonly children: XmlElement[];
  readonly text: string[];
}

const MAX_PARSER_BYTES = 8 * 1024 * 1024;
const JSON_CONTENT_TYPES = ["application/json", "text/json"] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} is not a valid date-time`);
  return new Date(timestamp).toISOString();
}

function canonicalUrl(value: string, base: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name} must be credential-free HTTPS`);
  }
  url.hash = "";
  return url.toString();
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function firstValue(record: JsonRecord, paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    const value = atPath(record, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function firstText(record: JsonRecord, paths: readonly (readonly string[])[]): string | null {
  const value = firstValue(record, paths);
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function structuredText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(structuredText).filter((entry): entry is string => entry !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const orderedKeys = [
    "name",
    "streetAddress",
    "addressLocality",
    "city",
    "addressRegion",
    "state",
    "addressCountry",
    "country",
    "address",
    "value"
  ];
  const orderedValues = orderedKeys
    .filter((key) => record[key] !== undefined)
    .map((key) => structuredText(record[key]))
    .filter((entry): entry is string => entry !== null);
  if (orderedValues.length > 0) return orderedValues.join(", ");
  const remaining = Object.keys(record).sort(compareText)
    .map((key) => structuredText(record[key]))
    .filter((entry): entry is string => entry !== null);
  return remaining.length > 0 ? remaining.join(" ") : null;
}

function firstStructuredText(record: JsonRecord, paths: readonly (readonly string[])[]): string | null {
  for (const path of paths) {
    const text = structuredText(atPath(record, path));
    if (text !== null) return text;
  }
  return null;
}

function decodeEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, token: string) => {
    const lower = token.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[lower] ?? match;
  });
}

function plainText(value: string): string {
  let output = "";
  let cursor = 0;
  let blockedTag: "script" | "style" | null = null;
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    if (open < 0) {
      if (blockedTag === null) output += value.slice(cursor);
      break;
    }
    if (blockedTag === null) output += value.slice(cursor, open);
    let close = open + 1;
    let quote: string | null = null;
    while (close < value.length) {
      const character = value[close]!;
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      close += 1;
    }
    if (close >= value.length) {
      if (blockedTag === null) output += value.slice(open);
      break;
    }
    const tag = value.slice(open + 1, close).trim().toLowerCase();
    if (tag.startsWith("script") && !tag.startsWith("script/")) blockedTag = "script";
    if (tag.startsWith("style") && !tag.startsWith("style/")) blockedTag = "style";
    if (tag.startsWith("/script")) blockedTag = null;
    if (tag.startsWith("/style")) blockedTag = null;
    if (blockedTag === null) output += " ";
    cursor = close + 1;
  }
  return decodeEntities(output).replace(/\s+/g, " ").trim().slice(0, 200_000);
}

function parseBody(input: ProviderParseInput): unknown {
  if (input.body.byteLength > MAX_PARSER_BYTES) throw new Error("Provider parser body exceeds 8 MiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.body);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Provider response is not valid UTF-8 JSON", { cause: error });
  }
}

function scanTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function xmlLocalName(value: string): string {
  const name = value.split(":").at(-1)?.toLowerCase() ?? "";
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(name)) throw new Error("Provider XML contains an invalid element name");
  return name;
}

function xmlElementRecord(element: XmlElement): JsonRecord | string {
  const childRecord: JsonRecord = {};
  for (const child of element.children) {
    const value = xmlElementRecord(child);
    const existing = childRecord[child.name];
    if (existing === undefined) childRecord[child.name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else childRecord[child.name] = [existing, value];
  }
  const text = decodeEntities(element.text.join(" ")).replace(/\s+/g, " ").trim();
  if (Object.keys(childRecord).length === 0) return text;
  if (text) childRecord["textValue"] = text;
  return childRecord;
}

function parseBoundedXmlRecords(input: ProviderParseInput): unknown[] {
  if (input.body.byteLength > MAX_PARSER_BYTES) throw new Error("Provider parser body exceeds 8 MiB");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(input.body);
  if (/<!\s*(?:doctype|entity)\b/i.test(xml)) {
    throw new Error("Provider XML declarations and entities are not permitted");
  }
  const document: XmlElement = { name: "document", children: [], text: [] };
  const stack: XmlElement[] = [document];
  let cursor = 0;
  let elementCount = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open < 0) {
      stack.at(-1)!.text.push(xml.slice(cursor));
      break;
    }
    if (open > cursor) stack.at(-1)!.text.push(xml.slice(cursor, open));
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) throw new Error("Provider XML contains an unterminated comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) throw new Error("Provider XML contains unterminated CDATA");
      stack.at(-1)!.text.push(xml.slice(open + 9, end));
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) throw new Error("Provider XML contains an unterminated processing instruction");
      cursor = end + 2;
      continue;
    }
    const tagEnd = scanTagEnd(xml, open + 1);
    if (tagEnd < 0) throw new Error("Provider XML contains an unterminated element");
    const rawTag = xml.slice(open + 1, tagEnd).trim();
    if (!rawTag || rawTag.startsWith("!")) throw new Error("Provider XML contains an unsupported declaration");
    if (rawTag.startsWith("/")) {
      const closingName = xmlLocalName(rawTag.slice(1).trim());
      const current = stack.pop();
      if (!current || current === document || current.name !== closingName) {
        throw new Error("Provider XML element nesting is invalid");
      }
    } else {
      const selfClosing = rawTag.endsWith("/");
      const nameToken = rawTag.slice(0, selfClosing ? -1 : undefined).trim().split(/\s+/, 1)[0]!;
      const element: XmlElement = { name: xmlLocalName(nameToken), children: [], text: [] };
      stack.at(-1)!.children.push(element);
      elementCount += 1;
      if (elementCount > 100_000 || stack.length > 64) throw new Error("Provider XML exceeds structural limits");
      if (!selfClosing) stack.push(element);
    }
    cursor = tagEnd + 1;
  }
  if (stack.length !== 1) throw new Error("Provider XML contains unclosed elements");
  const positions: XmlElement[] = [];
  const visit = (element: XmlElement): void => {
    if (["position", "job", "item", "entry"].includes(element.name)) positions.push(element);
    else element.children.forEach(visit);
  };
  document.children.forEach(visit);
  return positions.map((position) => xmlElementRecord(position));
}

function recordsAtRoots(payload: unknown, roots: readonly (readonly string[])[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  for (const root of roots) {
    const value = atPath(payload, root);
    if (Array.isArray(value)) return value;
  }
  return asRecord(payload) ? [payload] : [];
}

function recordView(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const attributes = asRecord(record["attributes"]);
  const descriptor = asRecord(record["MatchedObjectDescriptor"]);
  const job = asRecord(record["job"]);
  return { ...record, ...(attributes ?? {}), ...(descriptor ?? {}), ...(job ?? {}) };
}

function dateValue(record: JsonRecord, paths: readonly (readonly string[])[]): string | null {
  const value = firstValue(record, paths);
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string" && value.trim()) return canonicalTimestamp(value, "provider date");
  return null;
}

const ID_PATHS = [
  ["id"], ["jobId"], ["job_id"], ["requisitionId"], ["requisitionNumber"],
  ["PositionID"], ["positionId"], ["jobCode"], ["JobCode"],
  ["identifier", "value"], ["identifier"], ["uuid"], ["slug"], ["shortcode"], ["externalPath"]
] as const;
const TITLE_PATHS = [
  ["title"], ["text"], ["jobTitle"], ["job_title"], ["jobOpeningName"], ["PositionTitle"], ["positionTitle"], ["name"]
] as const;
const COMPANY_PATHS = [
  ["company"], ["companyName"], ["organization"], ["OrganizationName"], ["departmentName"],
  ["hiringOrganization", "name"], ["company-name"]
] as const;
const URL_PATHS = [
  ["absolute_url"], ["hostedUrl"], ["jobUrl"], ["PositionURI"], ["positionUri"], ["canonicalUrl"], ["url"], ["link"], ["ref"],
  ["links", "careersite-job-url"], ["externalPath"]
] as const;
const APPLY_URL_PATHS = [
  ["applyUrl"], ["apply_url"], ["applicationUrl"], ["ApplyURI", "0"], ["applyUri"], ["external-application-url"], ["url"]
] as const;
const DESCRIPTION_PATHS = [
  ["descriptionPlain"], ["description"], ["content"], ["jobDescription"], ["descriptionHtml"],
  ["QualificationSummary"], ["UserArea", "Details", "JobSummary"], ["body"], ["jobDescriptions"]
] as const;
const LOCATION_PATHS = [
  ["location", "name"], ["location"], ["locationText"], ["locationsText"],
  ["PositionLocationDisplay"], ["positionLocationDisplay"], ["primaryLocation"], ["categories", "location"], ["jobLocation"],
  ["applicantLocationRequirements"], ["jobLocationType"], ["office"]
] as const;
const POSTED_PATHS = [
  ["publishedAt"], ["published_at"], ["datePosted"], ["postedAt"], ["createdAt"], ["created_at"],
  ["PublicationStartDate"], ["pubDate"], ["created-at"], ["releasedDate"], ["updated_at"], ["startDate"]
] as const;
const DEADLINE_PATHS = [["validThrough"], ["deadline"], ["endDate"], ["closingDate"], ["ApplicationCloseDate"]] as const;

function postingFromRecord(
  providerId: DiscoveryProviderId,
  raw: unknown,
  input: ProviderParseInput
): DiscoveredProviderPosting {
  const record = recordView(raw);
  if (!record) throw new Error("Provider record must be an object");
  const roleTitle = firstText(record, TITLE_PATHS);
  const company = firstText(record, COMPANY_PATHS) ?? input.companyHint?.trim() ?? null;
  const explicitSourceRecordId = firstText(record, ID_PATHS);
  let rawUrl = firstText(record, URL_PATHS);
  if (!rawUrl && providerId === "schema-org-job-posting") rawUrl = input.finalUrl;
  if (!rawUrl && providerId === "personio" && explicitSourceRecordId) {
    rawUrl = new URL(`/job/${encodeURIComponent(explicitSourceRecordId)}`, input.finalUrl).toString();
  }
  if (!roleTitle) throw new Error("Provider record is missing role title");
  if (!company) throw new Error("Provider record is missing company identity");
  if (!rawUrl) throw new Error("Provider record is missing canonical URL");
  const canonical = canonicalUrl(rawUrl, input.finalUrl, "provider canonical URL");
  const sourceRecordId = explicitSourceRecordId ?? sha256(canonical).slice("sha256:".length, 39);
  if (!sourceRecordId.trim() || sourceRecordId.length > 512 || /[\0\r\n]/.test(sourceRecordId)) {
    throw new Error("Provider record has an invalid source record ID");
  }
  const rawApplyUrl = firstText(record, APPLY_URL_PATHS);
  const applyUrl = rawApplyUrl ? canonicalUrl(rawApplyUrl, canonical, "provider apply URL") : canonical;
  const description = firstStructuredText(record, DESCRIPTION_PATHS) ?? "";
  const location = firstStructuredText(record, LOCATION_PATHS) ?? "";
  const capturedAt = canonicalTimestamp(input.capturedAt, "capturedAt");
  const sourcePayloadHash = sha256(stableStringify(raw));
  const identity = { providerId, sourceRecordId, canonicalUrl: canonical, company, roleTitle };
  const digest = sha256(stableStringify(identity)).slice("sha256:".length, 39).toUpperCase();
  return Object.freeze({
    postingId: `DISC-${digest}`,
    providerId,
    sourceRecordId,
    sourceUrl: canonicalUrl(input.sourceUrl, input.sourceUrl, "sourceUrl"),
    canonicalUrl: canonical,
    applyUrl,
    company: company.replace(/\s+/g, " ").trim(),
    roleTitle: roleTitle.replace(/\s+/g, " ").trim(),
    location: plainText(location),
    descriptionText: plainText(description),
    postedAt: dateValue(record, POSTED_PATHS),
    deadline: dateValue(record, DEADLINE_PATHS),
    capturedAt,
    sourcePayloadHash
  });
}

function extractJsonLd(html: string): unknown[] {
  const lower = html.toLowerCase();
  const payloads: unknown[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = lower.indexOf("<script", cursor);
    if (start < 0) break;
    const tagEnd = lower.indexOf(">", start + 7);
    if (tagEnd < 0) break;
    const tag = lower.slice(start, tagEnd + 1);
    const end = lower.indexOf("</script", tagEnd + 1);
    if (end < 0) break;
    if (tag.includes("application/ld+json")) {
      const content = html.slice(tagEnd + 1, end).trim();
      if (content) {
        try {
          payloads.push(JSON.parse(content) as unknown);
        } catch {
          // A malformed JSON-LD block is isolated. Valid sibling blocks remain usable.
        }
      }
    }
    const close = lower.indexOf(">", end + 8);
    cursor = close < 0 ? html.length : close + 1;
  }
  return payloads;
}

function jobPostingObjects(value: unknown): JsonRecord[] {
  const records: JsonRecord[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    const type = record["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) records.push(record);
    const graph = record["@graph"];
    if (graph !== undefined) visit(graph);
  };
  visit(value);
  return records;
}

class FixtureContractAdapter implements DiscoveryProviderAdapter {
  public readonly contractVersion = "1.0.0" as const;
  public readonly executable = true as const;

  public constructor(private readonly definition: AdapterDefinition) {}

  public get providerId(): DiscoveryProviderId {
    return this.definition.providerId;
  }

  public get supportedContentTypes(): readonly string[] {
    return this.definition.supportedContentTypes;
  }

  public get requiresAtLeastOnePosting(): boolean {
    return this.definition.requiresAtLeastOnePosting ?? false;
  }

  public parse(input: ProviderParseInput): ProviderParseResult {
    if (input.body.byteLength > MAX_PARSER_BYTES) {
      throw new Error("Provider parser body exceeds 8 MiB");
    }
    const mediaType = input.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!this.supportedContentTypes.includes(mediaType)) {
      throw new Error(`Unsupported ${this.providerId} parser content type: ${mediaType}`);
    }
    let records: unknown[];
    if (mediaType === "text/html" || mediaType === "application/ld+json") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(input.body);
      const payloads = mediaType === "text/html" ? extractJsonLd(text) : [parseBody(input)];
      records = payloads.flatMap(jobPostingObjects);
    } else if (["application/xml", "text/xml", "application/rss+xml", "application/atom+xml"].includes(mediaType)) {
      records = parseBoundedXmlRecords(input);
    } else {
      records = recordsAtRoots(parseBody(input), this.definition.roots);
    }

    const postings: DiscoveredProviderPosting[] = [];
    const rejections: ProviderParseRejection[] = [];
    const sourceIds = new Set<string>();
    records.forEach((record, recordIndex) => {
      try {
        const posting = postingFromRecord(this.providerId, record, input);
        if (sourceIds.has(posting.sourceRecordId)) {
          rejections.push({ recordIndex, code: "duplicate-record", message: "Duplicate provider source record ID" });
          return;
        }
        sourceIds.add(posting.sourceRecordId);
        postings.push(posting);
      } catch (error) {
        rejections.push({
          recordIndex,
          code: "invalid-record",
          message: error instanceof Error ? error.message : "Provider record is invalid"
        });
      }
    });
    postings.sort((left, right) => compareText(left.sourceRecordId, right.sourceRecordId));
    return Object.freeze({
      providerId: this.providerId,
      contractVersion: this.contractVersion,
      postings: Object.freeze(postings),
      rejections: Object.freeze(rejections)
    });
  }
}

const COMMON_ROOTS = [
  ["jobs"],
  ["postings"],
  ["positions"],
  ["results"],
  ["content"],
  ["data"],
  ["offers"],
  ["items"],
  ["entries"],
  ["jobPostings"],
  ["SearchResult", "SearchResultItems"],
  ["searchResult", "items"]
] as const;

const PARSER_CONTENT_TYPES = new Set([
  ...JSON_CONTENT_TYPES,
  "application/ld+json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "text/xml",
  "text/html",
  "text/plain"
]);

const DEFINITIONS: readonly AdapterDefinition[] = DISCOVERY_PROVIDER_MANIFESTS.map((manifest) => ({
  providerId: manifest.providerId as DiscoveryProviderId,
  roots: COMMON_ROOTS,
  supportedContentTypes: manifest.egress.responsePolicy.allowedContentTypes.filter((contentType) => PARSER_CONTENT_TYPES.has(contentType)),
  requiresAtLeastOnePosting: true
}));

export const DISCOVERY_PROVIDER_ADAPTERS: readonly DiscoveryProviderAdapter[] = Object.freeze(
  DEFINITIONS.map((definition) => new FixtureContractAdapter(definition))
);

export const MANDATORY_PROVIDER_ADAPTERS: readonly DiscoveryProviderAdapter[] = Object.freeze(
  DISCOVERY_PROVIDER_ADAPTERS.filter((adapter) => MANDATORY_PROVIDER_IDS.includes(adapter.providerId))
);

const ADAPTERS_BY_ID = new Map(DISCOVERY_PROVIDER_ADAPTERS.map((adapter) => [adapter.providerId, adapter]));

export function providerAdapterById(providerId: DiscoveryProviderId): DiscoveryProviderAdapter {
  const adapter = ADAPTERS_BY_ID.get(providerId);
  if (!adapter) throw new Error(`No executable discovery adapter is registered for ${providerId}`);
  return adapter;
}

const adapterIds = new Set(DISCOVERY_PROVIDER_ADAPTERS.map((adapter) => adapter.providerId));
if (
  adapterIds.size !== REQUIRED_DISCOVERY_PROVIDER_IDS.length ||
  REQUIRED_DISCOVERY_PROVIDER_IDS.some((providerId) => !adapterIds.has(providerId))
) {
  throw new Error("Discovery adapter registry does not match the approved provider set");
}
