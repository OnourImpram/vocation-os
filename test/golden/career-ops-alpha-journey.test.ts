import { expect, test } from "vitest";
import { runCareerOpsAlphaDemo } from "../../src/career-ops/demo.js";

test("completes a synthetic opportunity from three-stage verification to trusted confirmation", async () => {
  const result = await runCareerOpsAlphaDemo(new Date("2026-08-28T09:00:00.000Z"));

  expect(result.verification.status).toBe("verified");
  expect(result.legitimacy.tier).toBe("green");
  expect(result.grantDecision.allowed).toBe(true);
  expect(result.adapterId).toBe("career-ops-local-fixture");
  expect(result.outbox.status).toBe("confirmed");
  expect(result.applicationAttempt.status).toBe("confirmed");
  expect(result.proofEvaluation.status).toBe("confirmed");
  expect(result.applicationAttempt.proofId).toBe(result.outbox.proofId);
  expect(result.privateKeyMaterialPresent).toBe(false);
});
