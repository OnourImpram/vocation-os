import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("repository scans", () => {
  it("passes brand scan", () => {
    expect(() => execFileSync("node", ["scripts/brand-scan.mjs"], { encoding: "utf8" })).not.toThrow();
  }, 15_000);

  it("passes privacy scan", () => {
    expect(() => execFileSync("node", ["scripts/privacy-scan.mjs"], { encoding: "utf8" })).not.toThrow();
  }, 15_000);
});
