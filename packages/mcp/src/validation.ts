import type { JsonObject, JsonValue } from "./index.js";

export const MAX_JSON_DEPTH = 48;
export const MAX_JSON_NODES = 10_000;

export class McpInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "McpInputError";
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function assertJsonValue(
  value: unknown,
  label = "JSON value",
  options: { maxDepth?: number; maxNodes?: number } = {}
): asserts value is JsonValue {
  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH;
  const maxNodes = options.maxNodes ?? MAX_JSON_NODES;
  const ancestors = new Set<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) throw new McpInputError(`${label} exceeds the node limit`);
    if (depth > maxDepth) throw new McpInputError(`${label} exceeds the nesting limit`);
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
    ) return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new McpInputError(`${label} contains a non-finite number`);
      return;
    }
    if (typeof candidate !== "object") throw new McpInputError(`${label} is not JSON serializable`);
    if (ancestors.has(candidate)) throw new McpInputError(`${label} contains a cycle`);

    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
    } else {
      if (!isJsonObject(candidate)) throw new McpInputError(`${label} contains a non-plain object`);
      for (const entry of Object.values(candidate)) visit(entry, depth + 1);
    }
    ancestors.delete(candidate);
  };

  visit(value, 0);
}

export function requireJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new McpInputError(`${label} must be an object`);
  assertJsonValue(value, label);
  return value;
}

export function requireString(
  value: unknown,
  label: string,
  options: { maxLength?: number; pattern?: RegExp } = {}
): string {
  const maxLength = options.maxLength ?? 4_096;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || options.pattern?.test(value) === false
  ) {
    throw new McpInputError(`${label} is invalid`);
  }
  return value;
}

export function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new McpInputError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, { maxLength: 32 });
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new McpInputError(`${label} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

export function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
