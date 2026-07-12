import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("vocationd startup ordering", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = mkdtempSync(path.join(tmpdir(), "vocationd-startup-"));
  });

  afterEach(() => {
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("acquires the instance lock before prompting for or creating credentials and database state", () => {
    writeFileSync(path.join(runtimeRoot, "vocationd.lock.json"), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      endpoint: "unreachable-test-endpoint",
      ownerToken: "LOCK-HELD-BY-PARENT",
      startedAt: "2026-07-11T00:00:00.000Z"
    })}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/vocationd.ts", "start", "--headless"],
      {
        cwd: process.cwd(),
        env: { ...process.env, VOCATION_HOME: runtimeRoot },
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true
      }
    );

    if (result.error) {
      throw new Error(`vocationd startup subprocess failed: ${result.error.message}`);
    }
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already running");
    expect(result.stderr).not.toContain("interactive terminal");
    expect(existsSync(path.join(runtimeRoot, "headless-credentials.vault"))).toBe(false);
    expect(existsSync(path.join(runtimeRoot, "vocation.db"))).toBe(false);
  }, 70_000);
});
