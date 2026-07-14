import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("headless credential provider guidance", () => {
  it("fails with an actionable message when a headless daemon command omits --headless", () => {
    const runtimeRoot = mkdtempSync(path.join(tmpdir(), "vocation-headless-guidance-"));
    try {
      writeFileSync(path.join(runtimeRoot, "headless-credentials.vault"), "headless-provider-marker", "utf8");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "daemon-status"],
        {
          cwd: process.cwd(),
          env: { ...process.env, VOCATION_HOME: runtimeRoot },
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Re-run this command with --headless");
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }, 40_000);
});
