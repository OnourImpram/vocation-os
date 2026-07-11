import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface LockRecord {
  version: 1;
  pid: number;
  endpoint: string;
  ownerToken: string;
  startedAt: string;
}

export interface SingleInstanceLock {
  record: LockRecord;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function parseLock(filePath: string): LockRecord {
  let value: Partial<LockRecord>;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<LockRecord>;
  } catch {
    throw new Error("Daemon lock is unreadable. Refusing ambiguous stale lock recovery");
  }
  if (
    value.version !== 1
    || !Number.isInteger(value.pid)
    || typeof value.endpoint !== "string"
    || typeof value.ownerToken !== "string"
    || typeof value.startedAt !== "string"
  ) {
    throw new Error("Daemon lock is invalid. Refusing ambiguous stale lock recovery");
  }
  return value as LockRecord;
}

function createLock(filePath: string, endpoint: string, now: Date): SingleInstanceLock {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const record: LockRecord = {
    version: 1,
    pid: process.pid,
    endpoint,
    ownerToken: randomUUID(),
    startedAt: now.toISOString()
  };
  const descriptor = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return {
    record,
    release(): void {
      if (released) return;
      const current = parseLock(filePath);
      if (current.ownerToken !== record.ownerToken || current.pid !== record.pid) {
        throw new Error("Daemon lock ownership changed before release");
      }
      rmSync(filePath);
      released = true;
    }
  };
}

export async function acquireSingleInstanceLock(input: {
  lockPath: string;
  endpoint: string;
  endpointReachable: (endpoint: string) => Promise<boolean>;
  now?: Date;
}): Promise<SingleInstanceLock> {
  const lockPath = path.resolve(input.lockPath);
  const now = input.now ?? new Date();
  if (!existsSync(lockPath)) {
    if (await input.endpointReachable(input.endpoint)) {
      throw new Error("Daemon endpoint is reachable without a lock record. Refusing ambiguous lock recovery");
    }
    return createLock(lockPath, input.endpoint, now);
  }

  const existing = parseLock(lockPath);
  if (processIsAlive(existing.pid)) {
    throw new Error(`VocationOS daemon is already running with pid ${existing.pid}`);
  }
  if (await input.endpointReachable(existing.endpoint)) {
    throw new Error("Daemon endpoint remains reachable while its process record appears stale");
  }

  const stalePath = `${lockPath}.stale-${now.toISOString().replace(/[:.]/g, "")}-${existing.ownerToken}`;
  renameSync(lockPath, stalePath);
  try {
    return createLock(lockPath, input.endpoint, now);
  } catch (error) {
    if (!existsSync(lockPath) && existsSync(stalePath)) renameSync(stalePath, lockPath);
    throw error;
  }
}
