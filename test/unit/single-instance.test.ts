import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSingleInstanceLock, type SingleInstanceLock } from "../../src/runtime/single-instance.js";

function endpointFor(dir: string): string {
  const suffix = `${process.pid}-${randomUUID()}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\vocation-os-lock-test-${suffix}`
    : path.join(dir, `daemon-${suffix}.sock`);
}

describe("single instance lock", () => {
  let dir: string;
  let lockPath: string;
  let activeLock: SingleInstanceLock | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-lock-"));
    lockPath = path.join(dir, "vocationd.lock");
  });

  afterEach(() => {
    activeLock?.release();
    activeLock = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects concurrent acquisition while the recorded process is alive", async () => {
    const endpoint = endpointFor(dir);
    activeLock = await acquireSingleInstanceLock({
      lockPath,
      endpoint,
      endpointReachable: async () => false
    });

    await expect(acquireSingleInstanceLock({
      lockPath,
      endpoint,
      endpointReachable: async () => false
    })).rejects.toThrow("already running");
  });

  it("fails closed when the endpoint is reachable but the lock file is missing", async () => {
    const endpoint = endpointFor(dir);
    const endpointReachable = vi.fn(async (candidate: string) => candidate === endpoint);

    await expect(acquireSingleInstanceLock({
      lockPath,
      endpoint,
      endpointReachable
    })).rejects.toThrow("reachable without a lock record");

    expect(endpointReachable).toHaveBeenCalledWith(endpoint);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers a stale lock only when its process is dead and endpoint is unreachable", async () => {
    const oldEndpoint = endpointFor(dir);
    const oldOwnerToken = randomUUID();
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      endpoint: oldEndpoint,
      ownerToken: oldOwnerToken,
      startedAt: "2026-07-11T00:00:00.000Z"
    })}\n`, "utf8");

    const replacementEndpoint = endpointFor(dir);
    activeLock = await acquireSingleInstanceLock({
      lockPath,
      endpoint: replacementEndpoint,
      endpointReachable: async (endpoint) => {
        expect(endpoint).toBe(oldEndpoint);
        return false;
      },
      now: new Date("2026-07-11T12:00:00.000Z")
    });

    expect(activeLock.record.pid).toBe(process.pid);
    expect(activeLock.record.endpoint).toBe(replacementEndpoint);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
      endpoint: replacementEndpoint
    });
    expect(readdirSync(dir).some((name) => name.startsWith("vocationd.lock.stale-") && name.includes(oldOwnerToken))).toBe(true);
  });

  it("fails closed when an existing lock is unreadable", async () => {
    writeFileSync(lockPath, "{not-json", "utf8");
    const endpointReachable = vi.fn(async () => false);

    await expect(acquireSingleInstanceLock({
      lockPath,
      endpoint: endpointFor(dir),
      endpointReachable
    })).rejects.toThrow("unreadable");

    expect(endpointReachable).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("fails closed when a dead process record still has a reachable endpoint", async () => {
    const oldEndpoint = endpointFor(dir);
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      endpoint: oldEndpoint,
      ownerToken: randomUUID(),
      startedAt: "2026-07-11T00:00:00.000Z"
    })}\n`, "utf8");

    await expect(acquireSingleInstanceLock({
      lockPath,
      endpoint: endpointFor(dir),
      endpointReachable: async () => true
    })).rejects.toThrow("endpoint remains reachable");

    expect(existsSync(lockPath)).toBe(true);
    expect(readdirSync(dir).some((name) => name.includes(".stale-"))).toBe(false);
  });
});
