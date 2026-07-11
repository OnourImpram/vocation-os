import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { assertSchema } from "../schema.js";
import { decodeStateKey, inferSchemaName } from "../state.js";
import { sha256, stableStringify } from "../hash.js";
import type { ActionLedgerEntry, AutoApplyConfig } from "../types.js";
import type { EncryptedEventStore } from "./encrypted-event-store.js";

export type LegacySourceKind = "state" | "auto-apply-config" | "action-ledger";

export interface LegacyImportCandidate {
  sourceKind: LegacySourceKind;
  sourceDigest: string;
  sourceLocatorHash: string;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export interface LegacyImportPlan {
  version: 1;
  valid: boolean;
  planHash: string;
  sourceCounts: Record<LegacySourceKind, number>;
  candidates: LegacyImportCandidate[];
  warnings: string[];
  errors: string[];
}

export interface LegacyImportResult {
  planHash: string;
  imported: number;
  alreadyImported: number;
  sourceFilesPreserved: true;
  eventIds: string[];
}

export interface LegacyImportPlanSummary {
  version: 1;
  valid: boolean;
  planHash: string;
  sourceCounts: Record<LegacySourceKind, number>;
  candidates: Array<Omit<LegacyImportCandidate, "payload">>;
  warnings: string[];
  errors: string[];
}

function opaqueHash(value: string): string {
  return sha256(value).slice("sha256:".length);
}

function createCandidate(input: {
  sourceKind: LegacySourceKind;
  logicalLocator: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}): LegacyImportCandidate {
  const sourceLocatorHash = sha256(input.logicalLocator);
  const sourceDigest = sha256(stableStringify({
    sourceKind: input.sourceKind,
    sourceLocatorHash,
    payload: input.payload
  }));
  return {
    sourceKind: input.sourceKind,
    sourceDigest,
    sourceLocatorHash,
    eventId: `EVT-LEGACY-${opaqueHash(sourceDigest)}`,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function collectStateCandidates(
  runtimeRoot: string,
  candidates: LegacyImportCandidate[],
  warnings: string[],
  errors: string[]
): void {
  const stateDir = path.join(runtimeRoot, "_state");
  if (!existsSync(stateDir)) return;
  const logicalKeys = new Set<string>();
  for (const file of readdirSync(stateDir).filter((entry) => entry.endsWith(".json")).sort()) {
    const fileReference = sha256(`legacy-state-file:${file}`);
    try {
      const encodedKey = file.slice(0, -5);
      const key = decodeStateKey(encodedKey);
      if (logicalKeys.has(key)) throw new Error(`duplicate logical state key hash: ${sha256(key)}`);
      logicalKeys.add(key);
      const value = readJson(path.join(stateDir, file));
      const schemaName = inferSchemaName(key, value);
      if (schemaName) {
        assertSchema(schemaName, value);
      } else {
        warnings.push(`State entry ${fileReference} has no inferred schema and will be imported as opaque validated JSON`);
      }
      candidates.push(createCandidate({
        sourceKind: "state",
        logicalLocator: `state:${key}`,
        aggregateType: "legacy-state",
        aggregateId: `STATE-${opaqueHash(key).slice(0, 48)}`,
        eventType: "legacy-state-imported",
        payload: { key, schemaName, value }
      }));
    } catch (error) {
      errors.push(`State file ${fileReference}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function collectConfigCandidate(
  runtimeRoot: string,
  candidates: LegacyImportCandidate[],
  errors: string[]
): void {
  const filePath = path.join(runtimeRoot, "auto-apply-config.json");
  if (!existsSync(filePath)) return;
  try {
    const config = readJson(filePath) as AutoApplyConfig;
    assertSchema("auto-apply-config", config);
    candidates.push(createCandidate({
      sourceKind: "auto-apply-config",
      logicalLocator: "auto-apply-config",
      aggregateType: "runtime-config",
      aggregateId: "auto-apply",
      eventType: "legacy-auto-apply-config-imported",
      payload: { config }
    }));
  } catch (error) {
    errors.push(`Auto apply config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function collectLedgerCandidates(
  runtimeRoot: string,
  candidates: LegacyImportCandidate[],
  errors: string[]
): void {
  const filePath = path.join(runtimeRoot, "action-ledger.jsonl");
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const actionIds = new Set<string>();
  lines.forEach((line, index) => {
    if (line.length === 0) return;
    try {
      const entry = JSON.parse(line) as ActionLedgerEntry;
      assertSchema("action-ledger-entry", entry);
      if (actionIds.has(entry.actionId)) throw new Error(`duplicate action id ${entry.actionId}`);
      actionIds.add(entry.actionId);
      candidates.push(createCandidate({
        sourceKind: "action-ledger",
        logicalLocator: `action-ledger:${entry.actionId}`,
        aggregateType: "action-ledger",
        aggregateId: entry.actionId,
        eventType: "legacy-action-ledger-entry-imported",
        payload: { entry }
      }));
    } catch (error) {
      const finalLine = index === lines.length - 1 && !text.endsWith("\n");
      const suffix = finalLine ? " (unterminated final line)" : "";
      errors.push(`Action ledger line ${index + 1}${suffix}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function planLegacyImport(runtimeRoot: string): LegacyImportPlan {
  const resolvedRoot = path.resolve(runtimeRoot);
  const candidates: LegacyImportCandidate[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  collectStateCandidates(resolvedRoot, candidates, warnings, errors);
  collectConfigCandidate(resolvedRoot, candidates, errors);
  collectLedgerCandidates(resolvedRoot, candidates, errors);
  candidates.sort((left, right) => left.eventId.localeCompare(right.eventId));
  const sourceCounts: Record<LegacySourceKind, number> = {
    state: candidates.filter((candidate) => candidate.sourceKind === "state").length,
    "auto-apply-config": candidates.filter((candidate) => candidate.sourceKind === "auto-apply-config").length,
    "action-ledger": candidates.filter((candidate) => candidate.sourceKind === "action-ledger").length
  };
  const planBody = {
    version: 1 as const,
    sourceCounts,
    candidates,
    warnings: [...warnings].sort(),
    errors: [...errors].sort()
  };
  return {
    ...planBody,
    valid: errors.length === 0,
    planHash: sha256(stableStringify(planBody))
  };
}

export function summarizeLegacyImportPlan(plan: LegacyImportPlan): LegacyImportPlanSummary {
  const summary: LegacyImportPlanSummary = {
    version: plan.version,
    valid: plan.valid,
    planHash: plan.planHash,
    sourceCounts: plan.sourceCounts,
    candidates: plan.candidates.map(({ payload: _payload, ...candidate }) => candidate),
    warnings: plan.warnings,
    errors: plan.errors
  };
  assertSchema("legacy-import-report", summary);
  return summary;
}

export async function applyLegacyImport(
  store: EncryptedEventStore,
  plan: LegacyImportPlan,
  expectedPlanHash: string,
  now = new Date()
): Promise<LegacyImportResult> {
  if (!plan.valid) throw new Error("Invalid legacy import plan cannot be applied");
  if (expectedPlanHash !== plan.planHash) throw new Error("Legacy import plan hash does not match approval");
  let imported = 0;
  let alreadyImported = 0;
  const eventIds: string[] = [];
  for (const candidate of plan.candidates) {
    const priorReceipt = store.findLegacyImportReceipt(candidate.sourceDigest);
    if (priorReceipt) {
      if (priorReceipt.eventId !== candidate.eventId || priorReceipt.sourceLocatorHash !== candidate.sourceLocatorHash) {
        throw new Error(`Legacy import receipt conflict for ${candidate.sourceDigest}`);
      }
      alreadyImported += 1;
      eventIds.push(priorReceipt.eventId);
      continue;
    }
    if (!(await store.hasEvent(candidate.eventId))) {
      await store.append({
        eventId: candidate.eventId,
        aggregateType: candidate.aggregateType,
        aggregateId: candidate.aggregateId,
        eventType: candidate.eventType,
        schemaVersion: 1,
        occurredAt: now,
        payload: {
          source: {
            kind: candidate.sourceKind,
            digest: candidate.sourceDigest,
            locatorHash: candidate.sourceLocatorHash
          },
          value: candidate.payload
        }
      });
    }
    store.recordLegacyImportReceipt({
      sourceDigest: candidate.sourceDigest,
      sourceKind: candidate.sourceKind,
      sourceLocatorHash: candidate.sourceLocatorHash,
      eventId: candidate.eventId,
      importedAt: now.toISOString()
    });
    imported += 1;
    eventIds.push(candidate.eventId);
  }
  return {
    planHash: plan.planHash,
    imported,
    alreadyImported,
    sourceFilesPreserved: true,
    eventIds
  };
}
