import { describe, expect, it } from "vitest";
import { validateApplicationPacket, validateClaimGraph } from "../../src/claim-graph.js";
import { DEMO_DOCUMENT_ROOT, demoGraph, demoPacket } from "../fixtures.js";

describe("claim graph validation", () => {
  it("rejects validation summary mismatch", () => {
    const graph = demoGraph({
      validationSummary: {
        verifiedClaims: 0,
        unverifiedClaims: 0,
        privateClaims: 999
      }
    });
    const result = validateClaimGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("validation-summary-verified-count-mismatch");
    expect(result.reasons).toContain("validation-summary-private-count-mismatch");
  });

  it("rejects recency required claim without verified evidence", () => {
    const graph = demoGraph({
      claims: [
        {
          ...demoGraph().claims[0]!,
          evidenceStatus: "current_source_required",
          recencyRequired: true,
          recencyPolicyId: "legal-regulatory"
        }
      ],
      validationSummary: {
        verifiedClaims: 0,
        unverifiedClaims: 1,
        privateClaims: 0
      }
    });
    const result = validateApplicationPacket(demoPacket(), graph, { documentRoot: DEMO_DOCUMENT_ROOT });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("current-source-required:CLM-DEMO-001");
  });
});
