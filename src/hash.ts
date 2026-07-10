import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ApplicationPacket } from "./types.js";

export function normalizeClaimText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function computeClaimTextHash(text: string): string {
  return sha256(normalizeClaimText(text));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

export function canonicalPacketForHash(packet: ApplicationPacket): Omit<ApplicationPacket, "packetHash"> {
  const { packetHash: _packetHash, ...rest } = packet;
  return rest;
}

export function computePacketHash(packet: ApplicationPacket): string {
  return sha256(stableStringify(canonicalPacketForHash(packet)));
}

export function computeFileHash(filePath: string): string {
  return sha256(readFileSync(filePath));
}
