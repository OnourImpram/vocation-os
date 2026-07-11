import { createOpportunityRecord, normalizeWhitespace, type OpportunityRecord, type RemotePolicy } from "./opportunity.js";

export interface AdapterContext {
  company: string;
  sourceUrl: string;
  applicantLocationRequirements?: string[];
  capturedAt?: string;
  postedAt?: string | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || normalizeWhitespace(value).length === 0) {
    throw new Error(`${label} must be a non empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && normalizeWhitespace(value).length > 0 ? value : null;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  throw new Error(`${label} must be a string or number`);
}

function nestedString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const nested = value as Record<string, unknown>;
  return typeof nested[key] === "string" ? nested[key] : "";
}

function stripMarkup(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  );
}

function leverRemotePolicy(value: unknown): RemotePolicy | undefined {
  if (value === "remote" || value === "hybrid" || value === "on-site") {
    return value;
  }
  return undefined;
}

function ashbyRemotePolicy(payload: Record<string, unknown>): RemotePolicy | undefined {
  if (payload["isRemote"] === true) {
    return "remote";
  }
  const workplace = optionalString(payload["workplaceType"])?.toLowerCase();
  if (workplace === "remote" || workplace === "hybrid") {
    return workplace;
  }
  if (workplace === "on-site" || workplace === "onsite") {
    return "on-site";
  }
  return undefined;
}

function salaryText(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const salary = value as Record<string, unknown>;
  const currency = optionalString(salary["currency"]);
  const interval = optionalString(salary["interval"]);
  const minimum = typeof salary["min"] === "number" ? salary["min"] : null;
  const maximum = typeof salary["max"] === "number" ? salary["max"] : null;
  if (!currency || minimum === null || maximum === null) {
    return null;
  }
  return `${currency} ${minimum}-${maximum}${interval ? ` ${interval}` : ""}`;
}

export function normalizeGreenhouseJob(payload: unknown, context: AdapterContext): OpportunityRecord {
  const job = record(payload, "Greenhouse job");
  const absoluteUrl = requiredString(job["absolute_url"], "Greenhouse absolute_url");
  const locationText = nestedString(job["location"], "name");
  const content = optionalString(job["content"]) ?? "";
  return createOpportunityRecord({
    source: "greenhouse",
    sourceId: requiredId(job["id"], "Greenhouse id"),
    sourceUrl: context.sourceUrl,
    canonicalUrl: absoluteUrl,
    applyUrl: absoluteUrl,
    company: context.company,
    roleTitle: requiredString(job["title"], "Greenhouse title"),
    locationText,
    applicantLocationRequirements: context.applicantLocationRequirements,
    descriptionText: stripMarkup(content),
    postedAt: context.postedAt ?? null,
    capturedAt: context.capturedAt,
    extractionConfidence: content ? "high" : "medium",
    sourcePayload: payload
  });
}

export function normalizeLeverPosting(payload: unknown, context: AdapterContext): OpportunityRecord {
  const posting = record(payload, "Lever posting");
  const categories = typeof posting["categories"] === "object" && posting["categories"] !== null && !Array.isArray(posting["categories"])
    ? (posting["categories"] as Record<string, unknown>)
    : {};
  const createdAt = typeof posting["createdAt"] === "number" ? new Date(posting["createdAt"]).toISOString() : context.postedAt ?? null;
  const compensation = optionalString(posting["salaryDescriptionPlain"]) ?? salaryText(posting["salaryRange"]);
  const description = optionalString(posting["descriptionPlain"]) ?? optionalString(posting["openingPlain"]) ?? "";
  return createOpportunityRecord({
    source: "lever",
    sourceId: requiredId(posting["id"], "Lever id"),
    sourceUrl: context.sourceUrl,
    canonicalUrl: requiredString(posting["hostedUrl"], "Lever hostedUrl"),
    applyUrl: optionalString(posting["applyUrl"]),
    company: context.company,
    roleTitle: requiredString(posting["text"], "Lever text"),
    locationText: optionalString(categories["location"]) ?? "",
    remotePolicy: leverRemotePolicy(posting["workplaceType"]),
    applicantLocationRequirements: context.applicantLocationRequirements,
    compensationText: compensation,
    descriptionText: description,
    postedAt: createdAt,
    capturedAt: context.capturedAt,
    extractionConfidence: description ? "high" : "medium",
    sourcePayload: payload
  });
}

export function normalizeAshbyPosting(payload: unknown, context: AdapterContext): OpportunityRecord {
  const posting = record(payload, "Ashby posting");
  const jobUrl = requiredString(posting["jobUrl"], "Ashby jobUrl");
  const description = optionalString(posting["descriptionPlain"]) ?? stripMarkup(optionalString(posting["descriptionHtml"]) ?? "");
  const compensation = optionalString(posting["compensationTierSummary"]);
  return createOpportunityRecord({
    source: "ashby",
    sourceId: requiredId(posting["id"], "Ashby id"),
    sourceUrl: context.sourceUrl,
    canonicalUrl: jobUrl,
    applyUrl: optionalString(posting["applyUrl"]),
    company: context.company,
    roleTitle: requiredString(posting["title"], "Ashby title"),
    locationText: optionalString(posting["location"]) ?? "",
    remotePolicy: ashbyRemotePolicy(posting),
    applicantLocationRequirements: context.applicantLocationRequirements,
    compensationText: compensation,
    descriptionText: description,
    postedAt: optionalString(posting["publishedAt"]) ?? context.postedAt ?? null,
    capturedAt: context.capturedAt,
    extractionConfidence: description ? "high" : "medium",
    sourcePayload: payload
  });
}


