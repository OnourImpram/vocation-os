import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertSchema } from "./schema.js";
import { defaultRuntimeRoot } from "./paths.js";
import type { ActionLedgerEntry } from "./types.js";
import { randomUUID } from "node:crypto";

export function createActionId(date = new Date()): string {
  const year = date.getUTCFullYear();
  return `A-${year}-${randomUUID()}`;
}

export function defaultLedgerPath(): string {
  return path.join(defaultRuntimeRoot(), "action-ledger.jsonl");
}

export function appendLedgerEntry(filePath: string, entry: ActionLedgerEntry): void {
  assertSchema("action-ledger-entry", entry);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const duplicate = readLedger(filePath).some((existing) => existing.actionId === entry.actionId);
  if (duplicate) {
    throw new Error(`Duplicate action id: ${entry.actionId}`);
  }
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readLedger(filePath: string): ActionLedgerEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActionLedgerEntry);
}

export function summarizeLedger(filePath: string): Record<string, number> {
  const entries = readLedger(filePath);
  return entries.reduce<Record<string, number>>((summary, entry) => {
    summary[entry.result] = (summary[entry.result] ?? 0) + 1;
    if (entry.blockedBy) {
      const key = `blocked:${entry.blockedBy}`;
      summary[key] = (summary[key] ?? 0) + 1;
    }
    return summary;
  }, {});
}
