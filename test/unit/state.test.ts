import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeStateKey, readState, statePathForKey, validateStateDirectory, writeState } from "../../src/state.js";

describe("state", () => {
  it("encodes unsafe key characters for portable filenames", () => {
    const encoded = encodeStateKey("probe:with:colons");
    expect(encoded).not.toContain(":");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("\\");
  });

  it("writes and reads a key containing colons", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-state-"));
    try {
      writeState(dir, "probe:with:colons", { ok: true });
      expect(statePathForKey(dir, "probe:with:colons")).toMatch(/\.json$/);
      expect(readState<{ ok: boolean }>(dir, "probe:with:colons").ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails corrupt JSON during state validation", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-state-"));
    try {
      writeFileSync(path.join(dir, "bad.json"), "{bad json", "utf8");
      const report = validateStateDirectory(dir);
      expect(report.valid).toBe(false);
      expect(report.results[0]?.errors?.[0]).toMatch(/JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails schema violations during state validation", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-state-"));
    try {
      writeFileSync(path.join(dir, `${encodeStateKey("auto-apply:config:bad")}.json`), "{\"enabled\":true}", "utf8");
      const report = validateStateDirectory(dir);
      expect(report.valid).toBe(false);
      expect(report.results[0]?.schemaName).toBe("auto-apply-config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows parseable unknown state with warning", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocation-state-"));
    try {
      writeState(dir, "unknown:state", { ok: true });
      const report = validateStateDirectory(dir);
      expect(report.valid).toBe(true);
      expect(report.results[0]?.warning).toBe("schema not inferred");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
