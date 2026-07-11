import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type StorageOperationPhase =
  | "prepared"
  | "backup_complete"
  | "staged"
  | "verified"
  | "swapped"
  | "complete"
  | "rolled_back";

export interface StorageOperationJournal {
  version: 1;
  operationId: string;
  operation: "restore" | "legacy-import";
  phase: StorageOperationPhase;
  targetPath: string;
  stagingPath?: string;
  rollbackPath?: string;
  expectedHash?: string;
  updatedAt: string;
}

const OPERATION_PHASES = new Set<StorageOperationPhase>([
  "prepared",
  "backup_complete",
  "staged",
  "verified",
  "swapped",
  "complete",
  "rolled_back"
]);

function atomicWrite(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, "w", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, filePath);
}

export function writeOperationJournal(filePath: string, journal: StorageOperationJournal): void {
  atomicWrite(filePath, journal);
}

export function readOperationJournal(filePath: string): StorageOperationJournal | null {
  if (!existsSync(filePath)) return null;
  const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StorageOperationJournal>;
  if (
    value.version !== 1
    || typeof value.operationId !== "string"
    || (value.operation !== "restore" && value.operation !== "legacy-import")
    || typeof value.phase !== "string"
    || !OPERATION_PHASES.has(value.phase as StorageOperationPhase)
    || typeof value.targetPath !== "string"
    || typeof value.updatedAt !== "string"
  ) {
    throw new Error("Storage operation journal is invalid");
  }
  return value as StorageOperationJournal;
}
