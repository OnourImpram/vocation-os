import { describe, expect, it } from "vitest";
import { defaultAutoApplyConfig } from "../../src/auto-apply.js";
import { validateAgainstSchema, validateAllSchemaFiles } from "../../src/schema.js";

describe("schemas", () => {
  it("compiles every schema", () => {
    expect(validateAllSchemaFiles().valid).toBe(true);
  });

  it("validates auto apply config", () => {
    expect(validateAgainstSchema("auto-apply-config", defaultAutoApplyConfig()).valid).toBe(true);
  });

  it("rejects invalid nested config", () => {
    const invalid = {
      ...defaultAutoApplyConfig(),
      killSwitch: { available: true }
    };
    expect(validateAgainstSchema("auto-apply-config", invalid).valid).toBe(false);
  });
});
