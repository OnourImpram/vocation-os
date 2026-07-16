export const GOVERNED_HTTP_METHODS = ["GET", "HEAD"] as const;

export type GovernedHttpMethod = (typeof GOVERNED_HTTP_METHODS)[number];

export interface HttpStatusRange {
  readonly min: number;
  readonly max: number;
}

export interface EgressManifest {
  readonly manifestId: string;
  readonly providerId: string;
  readonly version: string;
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly allowedPathPrefixes: readonly string[];
  readonly allowedMethods: readonly GovernedHttpMethod[];
  readonly allowedRequestHeaders: readonly string[];
  readonly redirectPolicy: {
    readonly maxRedirects: number;
    readonly allowCrossHost: boolean;
  };
  readonly responsePolicy: {
    readonly allowedStatusRanges: readonly HttpStatusRange[];
    readonly allowedContentTypes: readonly string[];
    readonly requireContentType: boolean;
    readonly maxBodyBytes: number;
    readonly timeoutMs: number;
  };
  readonly ratePolicy: {
    readonly maxRequests: number;
    readonly windowMs: number;
  };
  readonly cachePolicy: {
    readonly ttlMs: number;
    readonly methods: readonly GovernedHttpMethod[];
  };
  readonly grantPolicy: {
    readonly maxTtlMs: number;
    readonly maxRequests: number;
    readonly requireExactHosts: boolean;
  };
}

export interface NetworkAccessGrant {
  readonly grantId: string;
  readonly subject: string;
  readonly purpose: string;
  readonly providerId: string;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly allowedHosts: readonly string[];
  readonly allowedMethods: readonly GovernedHttpMethod[];
  readonly requestBudget: number;
}

export interface NetworkAccessGrantVerificationContext {
  readonly manifest: EgressManifest;
  readonly verifiedAt: string;
}

export interface NetworkAccessGrantVerificationResult {
  readonly verified: boolean;
  readonly reason?: string;
}

export interface NetworkAccessGrantVerifier {
  verify(
    grant: NetworkAccessGrant,
    context: NetworkAccessGrantVerificationContext,
    signal: AbortSignal
  ): Promise<NetworkAccessGrantVerificationResult>;
}

export type GovernanceValidationResult =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly string[] };

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const MANIFEST_ID_PATTERN = /^egress:[a-z][a-z0-9-]{1,63}$/;
const GRANT_ID_PATTERN = /^NAG-[A-Z0-9][A-Z0-9-]{7,127}$/;
const HEADER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isPositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function isNonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function stringArray(
  value: unknown,
  path: string,
  errors: string[],
  predicate: (entry: string) => boolean,
  minimum = 1,
  maximum = 128
): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    errors.push(`${path} must contain between ${minimum} and ${maximum} entries`);
    return null;
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !predicate(entry)) {
      errors.push(`${path} contains an invalid entry`);
      continue;
    }
    entries.push(entry);
  }
  if (!hasUniqueStrings(entries)) errors.push(`${path} must not contain duplicates`);
  return entries;
}

function integerArray(
  value: unknown,
  path: string,
  errors: string[],
  predicate: (entry: number) => boolean,
  minimum = 1,
  maximum = 32
): number[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    errors.push(`${path} must contain between ${minimum} and ${maximum} entries`);
    return null;
  }
  const entries: number[] = [];
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || !predicate(entry)) {
      errors.push(`${path} contains an invalid entry`);
      continue;
    }
    entries.push(entry);
  }
  if (new Set(entries).size !== entries.length) errors.push(`${path} must not contain duplicates`);
  return entries;
}

function objectAt(value: unknown, path: string, errors: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  return value;
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  errors: string[]
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains an unexpected field: ${key}`);
  }
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isHostLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

export function normalizeHostname(value: string): string {
  const lower = value.trim().toLowerCase().replace(/\.$/, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

export function isValidHostPattern(value: string): boolean {
  if (value !== value.trim() || value !== value.toLowerCase() || value.endsWith(".")) return false;
  const normalized = normalizeHostname(value);
  const hostname = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  if (hostname.length === 0 || hostname.length > 253 || hostname.includes("*") || hostname.includes("..")) {
    return false;
  }
  if (/^[0-9a-f:.]+$/i.test(hostname) && hostname.includes(":")) {
    return !normalized.startsWith("*.");
  }
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !isHostLabel(label))) return false;
  return !normalized.startsWith("*.") || labels.length >= 2;
}

export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = normalizeHostname(hostname);
  const normalizedPattern = normalizeHostname(pattern);
  if (!normalizedPattern.startsWith("*.")) return host === normalizedPattern;
  const suffix = normalizedPattern.slice(2);
  return host !== suffix && host.endsWith(`.${suffix}`);
}

export function hostPatternIsWithin(childPattern: string, parentPattern: string): boolean {
  const child = normalizeHostname(childPattern);
  const parent = normalizeHostname(parentPattern);
  if (!child.startsWith("*.")) return hostMatchesPattern(child, parent);
  if (!parent.startsWith("*.")) return false;
  const childSuffix = child.slice(2);
  const parentSuffix = parent.slice(2);
  return childSuffix === parentSuffix || childSuffix.endsWith(`.${parentSuffix}`);
}

function fullyDecodePath(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < 4; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  try {
    return decodeURIComponent(decoded) === decoded ? decoded : null;
  } catch {
    return null;
  }
}

function hasForbiddenPathContent(value: string): boolean {
  return value.includes("\\") || value.split("/").some((segment) => segment === ".." || segment.includes("\0"));
}

function isPathPrefix(value: string): boolean {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) return false;
  const decoded = fullyDecodePath(value);
  return decoded !== null && !hasForbiddenPathContent(decoded);
}

function isContentType(value: string): boolean {
  return CONTENT_TYPE_PATTERN.test(value);
}

function isMethod(value: string): value is GovernedHttpMethod {
  return (GOVERNED_HTTP_METHODS as readonly string[]).includes(value);
}

function validateStatusRanges(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    errors.push("responsePolicy.allowedStatusRanges must contain between 1 and 16 ranges");
    return;
  }
  const normalized: Array<{ min: number; max: number }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isNonNegativeInteger(entry["min"], 599) || !isNonNegativeInteger(entry["max"], 599)) {
      errors.push("responsePolicy.allowedStatusRanges contains an invalid range");
      continue;
    }
    rejectUnexpectedKeys(entry, ["min", "max"], "responsePolicy.allowedStatusRanges entry", errors);
    const min = entry["min"];
    const max = entry["max"];
    if (min < 100 || max < min) {
      errors.push("responsePolicy.allowedStatusRanges must stay within HTTP status bounds");
      continue;
    }
    normalized.push({ min, max });
  }
  normalized.sort((left, right) => left.min - right.min || left.max - right.max);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous && current && current.min <= previous.max) {
      errors.push("responsePolicy.allowedStatusRanges must not overlap");
      break;
    }
  }
}

export function validateEgressManifest(value: unknown): GovernanceValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["EgressManifest must be an object"] };
  rejectUnexpectedKeys(value, [
    "manifestId",
    "providerId",
    "version",
    "allowedHosts",
    "allowedPorts",
    "allowedPathPrefixes",
    "allowedMethods",
    "allowedRequestHeaders",
    "redirectPolicy",
    "responsePolicy",
    "ratePolicy",
    "cachePolicy",
    "grantPolicy"
  ], "EgressManifest", errors);

  if (typeof value["manifestId"] !== "string" || !MANIFEST_ID_PATTERN.test(value["manifestId"])) {
    errors.push("manifestId is invalid");
  }
  if (typeof value["providerId"] !== "string" || !PROVIDER_ID_PATTERN.test(value["providerId"])) {
    errors.push("providerId is invalid");
  }
  if (typeof value["version"] !== "string" || !/^\d+\.\d+\.\d+$/.test(value["version"])) {
    errors.push("version must be semantic version text");
  }
  if (
    typeof value["manifestId"] === "string" &&
    typeof value["providerId"] === "string" &&
    value["manifestId"] !== `egress:${value["providerId"]}`
  ) {
    errors.push("manifestId must be bound to providerId");
  }

  stringArray(value["allowedHosts"], "allowedHosts", errors, isValidHostPattern);
  integerArray(value["allowedPorts"], "allowedPorts", errors, (port) => port >= 1 && port <= 65_535);
  stringArray(value["allowedPathPrefixes"], "allowedPathPrefixes", errors, isPathPrefix);
  const methods = stringArray(value["allowedMethods"], "allowedMethods", errors, isMethod, 1, 2);
  stringArray(
    value["allowedRequestHeaders"],
    "allowedRequestHeaders",
    errors,
    (header) => header === header.toLowerCase() && HEADER_NAME_PATTERN.test(header),
    0,
    32
  );

  const redirectPolicy = objectAt(value["redirectPolicy"], "redirectPolicy", errors);
  if (redirectPolicy) {
    rejectUnexpectedKeys(redirectPolicy, ["maxRedirects", "allowCrossHost"], "redirectPolicy", errors);
    if (!isNonNegativeInteger(redirectPolicy["maxRedirects"], 10)) {
      errors.push("redirectPolicy.maxRedirects must be an integer from 0 to 10");
    }
    if (typeof redirectPolicy["allowCrossHost"] !== "boolean") {
      errors.push("redirectPolicy.allowCrossHost must be boolean");
    }
  }

  const responsePolicy = objectAt(value["responsePolicy"], "responsePolicy", errors);
  if (responsePolicy) {
    rejectUnexpectedKeys(responsePolicy, [
      "allowedStatusRanges",
      "allowedContentTypes",
      "requireContentType",
      "maxBodyBytes",
      "timeoutMs"
    ], "responsePolicy", errors);
    validateStatusRanges(responsePolicy["allowedStatusRanges"], errors);
    stringArray(
      responsePolicy["allowedContentTypes"],
      "responsePolicy.allowedContentTypes",
      errors,
      (contentType) => contentType === contentType.toLowerCase() && isContentType(contentType),
      1,
      32
    );
    if (typeof responsePolicy["requireContentType"] !== "boolean") {
      errors.push("responsePolicy.requireContentType must be boolean");
    }
    if (!isPositiveInteger(responsePolicy["maxBodyBytes"], 64 * 1024 * 1024)) {
      errors.push("responsePolicy.maxBodyBytes must be between 1 byte and 64 MiB");
    }
    if (!isPositiveInteger(responsePolicy["timeoutMs"], 120_000)) {
      errors.push("responsePolicy.timeoutMs must be between 1 and 120000 milliseconds");
    }
  }

  const ratePolicy = objectAt(value["ratePolicy"], "ratePolicy", errors);
  if (ratePolicy) {
    rejectUnexpectedKeys(ratePolicy, ["maxRequests", "windowMs"], "ratePolicy", errors);
    if (!isPositiveInteger(ratePolicy["maxRequests"], 100_000)) {
      errors.push("ratePolicy.maxRequests must be a positive bounded integer");
    }
    if (!isPositiveInteger(ratePolicy["windowMs"], 86_400_000)) {
      errors.push("ratePolicy.windowMs must be a positive bounded integer");
    }
  }

  const cachePolicy = objectAt(value["cachePolicy"], "cachePolicy", errors);
  if (cachePolicy) {
    rejectUnexpectedKeys(cachePolicy, ["ttlMs", "methods"], "cachePolicy", errors);
    if (!isNonNegativeInteger(cachePolicy["ttlMs"], 86_400_000)) {
      errors.push("cachePolicy.ttlMs must be a bounded non-negative integer");
    }
    const cacheMethods = stringArray(cachePolicy["methods"], "cachePolicy.methods", errors, isMethod, 0, 2);
    if (methods && cacheMethods && cacheMethods.some((method) => !methods.includes(method))) {
      errors.push("cachePolicy.methods must be a subset of allowedMethods");
    }
  }

  const grantPolicy = objectAt(value["grantPolicy"], "grantPolicy", errors);
  if (grantPolicy) {
    rejectUnexpectedKeys(grantPolicy, ["maxTtlMs", "maxRequests", "requireExactHosts"], "grantPolicy", errors);
    if (!isPositiveInteger(grantPolicy["maxTtlMs"], 7 * 86_400_000)) {
      errors.push("grantPolicy.maxTtlMs must be a positive bounded integer");
    }
    if (!isPositiveInteger(grantPolicy["maxRequests"], 1_000_000)) {
      errors.push("grantPolicy.maxRequests must be a positive bounded integer");
    }
    if (typeof grantPolicy["requireExactHosts"] !== "boolean") {
      errors.push("grantPolicy.requireExactHosts must be boolean");
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function assertValidEgressManifest(value: unknown): asserts value is EgressManifest {
  const result = validateEgressManifest(value);
  if (!result.valid) throw new Error(`EgressManifest validation failed: ${result.errors.join("; ")}`);
}

export function validateNetworkAccessGrant(
  value: unknown,
  manifest: EgressManifest,
  now = new Date()
): GovernanceValidationResult {
  const errors: string[] = [];
  const manifestResult = validateEgressManifest(manifest);
  if (!manifestResult.valid) {
    return { valid: false, errors: manifestResult.errors.map((error) => `manifest: ${error}`) };
  }
  if (!isRecord(value)) return { valid: false, errors: ["NetworkAccessGrant must be an object"] };
  rejectUnexpectedKeys(value, [
    "grantId",
    "subject",
    "purpose",
    "providerId",
    "manifestId",
    "manifestVersion",
    "issuedAt",
    "expiresAt",
    "allowedHosts",
    "allowedMethods",
    "requestBudget"
  ], "NetworkAccessGrant", errors);

  if (typeof value["grantId"] !== "string" || !GRANT_ID_PATTERN.test(value["grantId"])) {
    errors.push("grantId is invalid");
  }
  if (!isNonEmptyString(value["subject"], 160)) errors.push("subject is invalid");
  if (!isNonEmptyString(value["purpose"], 512)) errors.push("purpose is invalid");
  if (value["providerId"] !== manifest.providerId) errors.push("providerId does not match the manifest");
  if (value["manifestId"] !== manifest.manifestId) errors.push("manifestId does not match the manifest");
  if (value["manifestVersion"] !== manifest.version) errors.push("manifestVersion does not match the manifest");

  const grantHosts = stringArray(value["allowedHosts"], "allowedHosts", errors, isValidHostPattern);
  if (grantHosts) {
    for (const host of grantHosts) {
      if (manifest.grantPolicy.requireExactHosts && normalizeHostname(host).startsWith("*.")) {
        errors.push("allowedHosts must contain exact hosts for this manifest");
      }
      if (!manifest.allowedHosts.some((parent) => hostPatternIsWithin(host, parent))) {
        errors.push(`allowed host is outside the manifest boundary: ${host}`);
      }
    }
  }

  const grantMethods = stringArray(value["allowedMethods"], "allowedMethods", errors, isMethod, 1, 2);
  if (grantMethods && grantMethods.some((method) => !manifest.allowedMethods.some((allowed) => allowed === method))) {
    errors.push("allowedMethods must be a subset of the manifest methods");
  }

  if (!isPositiveInteger(value["requestBudget"], manifest.grantPolicy.maxRequests)) {
    errors.push("requestBudget exceeds the manifest grant policy");
  }
  if (!isIsoDateTime(value["issuedAt"])) errors.push("issuedAt must be an ISO date-time");
  if (!isIsoDateTime(value["expiresAt"])) errors.push("expiresAt must be an ISO date-time");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) errors.push("grant validation time is invalid");

  if (isIsoDateTime(value["issuedAt"]) && isIsoDateTime(value["expiresAt"]) && Number.isFinite(nowMs)) {
    const issuedAt = Date.parse(value["issuedAt"]);
    const expiresAt = Date.parse(value["expiresAt"]);
    if (expiresAt <= issuedAt) errors.push("expiresAt must be after issuedAt");
    if (expiresAt - issuedAt > manifest.grantPolicy.maxTtlMs) errors.push("grant lifetime exceeds the manifest policy");
    if (issuedAt > nowMs) errors.push("grant is not active yet");
    if (expiresAt <= nowMs) errors.push("grant has expired");
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function assertValidNetworkAccessGrant(
  value: unknown,
  manifest: EgressManifest,
  now = new Date()
): asserts value is NetworkAccessGrant {
  const result = validateNetworkAccessGrant(value, manifest, now);
  if (!result.valid) throw new Error(`NetworkAccessGrant validation failed: ${result.errors.join("; ")}`);
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
}

export function validateUrlAuthorization(
  value: string,
  method: GovernedHttpMethod,
  manifest: EgressManifest,
  grant: NetworkAccessGrant
): GovernanceValidationResult {
  const errors: string[] = [];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { valid: false, errors: ["request URL is invalid"] };
  }
  if (url.protocol !== "https:") errors.push("request URL must use HTTPS");
  if (url.username || url.password) errors.push("request URL must not contain embedded credentials");
  if (url.hash) errors.push("request URL must not contain a fragment");
  if (url.hostname.endsWith(".")) errors.push("request URL must not contain a trailing dot hostname");
  const hostname = normalizeHostname(url.hostname);
  if (!manifest.allowedHosts.some((pattern) => hostMatchesPattern(hostname, pattern))) {
    errors.push("request host is outside the manifest boundary");
  }
  if (!grant.allowedHosts.some((pattern) => hostMatchesPattern(hostname, pattern))) {
    errors.push("request host is outside the grant boundary");
  }
  const port = url.port ? Number(url.port) : 443;
  if (!manifest.allowedPorts.includes(port)) errors.push("request port is outside the manifest boundary");
  if (!manifest.allowedMethods.includes(method) || !grant.allowedMethods.includes(method)) {
    errors.push("request method is not authorized");
  }
  const decodedPath = fullyDecodePath(url.pathname);
  if (decodedPath === null) {
    errors.push("request path contains invalid percent encoding");
  }
  if (decodedPath !== null && hasForbiddenPathContent(decodedPath)) {
    errors.push("request path contains a forbidden traversal segment");
  }
  if (
    decodedPath === null ||
    !manifest.allowedPathPrefixes.some((prefix) => {
      const decodedPrefix = fullyDecodePath(prefix);
      return decodedPrefix !== null && pathMatchesPrefix(decodedPath, decodedPrefix);
    })
  ) {
    errors.push("request path is outside the manifest boundary");
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}
