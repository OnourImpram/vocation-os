import { describe, expect, it } from "vitest";
import { demoDimensions, scoreOpportunity } from "../../src/rubric.js";
import { demoApprovalReference } from "../fixtures.js";

describe("rubric", () => {
  it("rejects duplicate dimension ids", () => {
    const dimensions = demoDimensions();
    dimensions[1] = { ...dimensions[0]! };
    expect(() => scoreOpportunity({ dimensions })).toThrow(/Duplicate rubric dimension id/);
  });

  it("rejects scores outside 0 to 100", () => {
    const dimensions = demoDimensions();
    dimensions[0] = { ...dimensions[0]!, score: 101 };
    expect(() => scoreOpportunity({ dimensions })).toThrow(/Invalid score/);
  });

  it("requires approval reference for forced score", () => {
    expect(() => scoreOpportunity({ dimensions: demoDimensions(), forced: true })).toThrow(/approval reference/);
  });

  it("keeps forced score confidence low", () => {
    const score = scoreOpportunity({
      dimensions: demoDimensions(),
      forced: true,
      approvalReference: demoApprovalReference()
    });
    expect(score.confidence).toBe("Low");
    expect(score.auditReference).toMatch(/^approval:sha256:/);
  });

  it("applies ethical cap", () => {
    const dimensions = demoDimensions(88);
    dimensions[16] = { ...dimensions[16]!, score: 20 };
    const score = scoreOpportunity({ dimensions });
    expect(score.compositeScore).toBeLessThanOrEqual(39);
  });

  it("rejects precise score with weak evidence unless forced", () => {
    const dimensions = demoDimensions();
    dimensions[0] = { ...dimensions[0]!, evidenceStatus: "current_source_required" };
    expect(() => scoreOpportunity({ dimensions })).toThrow(/Weak evidence/);
  });
});
