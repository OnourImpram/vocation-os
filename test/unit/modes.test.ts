import { describe, expect, it } from "vitest";
import { runDeepFit, runMode } from "../../src/modes.js";
import { demoDimensions } from "../../src/rubric.js";

describe("modes", () => {
  it("deep fit sets high stakes gate when route is sensitive", () => {
    const output = runDeepFit({
      dimensions: demoDimensions(),
      highStakesFlags: { immigrationSensitive: true }
    });
    expect(output.highStakesCertaintyGate).toBe(true);
    expect(output.humanApprovalRequired).toBe(true);
    expect(output.specialistQuestions.length).toBeGreaterThan(0);
  });

  it("auto apply config is valid mode output", () => {
    expect(runMode("/auto-apply-config").highStakesCertaintyGate).toBe(true);
    expect(runMode("/auto-apply-config").specialistQuestions.length).toBeGreaterThan(0);
  });
});
