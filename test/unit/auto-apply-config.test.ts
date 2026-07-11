import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAutoApplyConfig, saveAutoApplyConfig } from "../../src/auto-apply-config.js";
import { defaultAutoApplyConfig, engageKillSwitch, rearmAutoApply } from "../../src/auto-apply.js";

describe("persistent auto apply config", () => {
  it("persists an engaged kill switch across reloads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-config-"));
    const filePath = path.join(dir, "auto-apply-config.json");
    try {
      const engaged = engageKillSwitch(defaultAutoApplyConfig(), "test-operator", "safety stop");
      saveAutoApplyConfig(engaged, filePath);
      const reloaded = loadAutoApplyConfig(filePath);
      expect(reloaded.killSwitch.engaged).toBe(true);
      expect(reloaded.enabled).toBe(false);
      expect(reloaded.mode).toBe("manual");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rearm does not enable automation", () => {
    const engaged = engageKillSwitch(defaultAutoApplyConfig(), "test-operator", "safety stop");
    const rearmed = rearmAutoApply(engaged, "REARM-AUTO-APPLY");
    expect(rearmed.killSwitch.engaged).toBe(false);
    expect(rearmed.enabled).toBe(false);
    expect(rearmed.mode).toBe("manual");
  });
});
