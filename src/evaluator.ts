import { generateKeyPairSync, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAutoApply, defaultAutoApplyConfig, engageKillSwitch, type AutoApplyInput } from "./auto-apply.js";
import { createApprovalReference, type TrustedApprover } from "./approval.js";
import { createVocationBenchManifest } from "./benchmark/vocation-bench.js";
import { createCareerTwin } from "./career-twin.js";
import { validateApplicationPacket } from "./claim-graph.js";
import { computeActionIntentHash, computeClaimTextHash, computeFileHash, computePacketHash, sha256, stableStringify } from "./hash.js";
import { runDeepFit } from "./modes.js";
import { EXAMPLES_DIR, PACKAGE_ROOT } from "./paths.js";
import { demoDimensions, scoreOpportunity } from "./rubric.js";
import { validateAllSchemaFiles } from "./schema.js";
import { encodeStateKey } from "./state.js";
import { validateTheoryRegistry } from "./theory.js";
import { HIGH_STAKES_FLAGS, MODE_NAMES, PRODUCT_NAME, type ApplicationPacket, type ClaimGraph, type HighStakesFlags } from "./types.js";

export interface EvaluatorCase {
  id: string;
  name: string;
  run: () => boolean;
}

function demoGraph(): ClaimGraph {
  const claimText = "Demo operator has completed a synthetic research project.";
  return {
    profileId: "DEMO-OPERATOR-001",
    profileScope: "synthetic",
    generatedAt: "2026-07-04T00:00:00.000Z",
    graphVersion: "0.2.0",
    claims: [
      {
        claimId: "CLM-DEMO-001",
        text: claimText,
        canonicalTextHash: computeClaimTextHash(claimText),
        claimType: "project",
        evidenceStatus: "verified",
        sourceType: "operator-supplied",
        sourcePointer: "examples/demo-profile/source.md#project",
        verifiedDate: "2026-07-04",
        recencyRequired: false,
        publiclyAssertable: true,
        allowedInCv: true,
        allowedInOutreach: true,
        allowedInAutoApply: true
      }
    ],
    validationSummary: {
      verifiedClaims: 1,
      unverifiedClaims: 0,
      privateClaims: 0
    }
  };
}

function packet(status: "verified" | "unverified" = "verified"): ApplicationPacket {
  const claimText = "Demo operator has completed a synthetic research project.";
  const packetValue: ApplicationPacket = {
    opportunityId: "OPP-DEMO-001",
    claims: [
      {
        claimId: "CLM-DEMO-001",
        text: claimText,
        sourceClaimTextHash: computeClaimTextHash(claimText),
        evidenceStatus: status,
        sourcePointer: "examples/demo-profile/source.md#project",
        publiclyAssertable: true
      }
    ],
    documents: [{
      kind: "cv",
      path: path.join(EXAMPLES_DIR, "demo-profile", "source.md"),
      contentHash: computeFileHash(path.join(EXAMPLES_DIR, "demo-profile", "source.md"))
    }],
    tosCompliant: true,
    generatedAt: "2026-07-04T00:00:00.000Z",
    packetHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    approvalRequired: true
  };
  return {
    ...packetValue,
    packetHash: computePacketHash(packetValue)
  };
}

const EVALUATOR_NOW = new Date("2026-07-04T01:00:00.000Z");
const evaluatorApproverKeyPair = generateKeyPairSync("ed25519");
const evaluatorTrustedApprover: TrustedApprover = {
  approvedBy: "evaluator",
  keyId: "KEY-EVALUATOR-001",
  publicKeyPem: evaluatorApproverKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
};

function approvalReference(packetValue = packet()) {
  return createApprovalReference({
    approvalId: "APR-EVAL-001",
    operation: "auto-apply",
    approvedBy: evaluatorTrustedApprover.approvedBy,
    keyId: evaluatorTrustedApprover.keyId,
    approvedAt: "2026-07-04T00:30:00.000Z",
    expiresAt: "2026-07-04T02:00:00.000Z",
    approvalTextHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    opportunityId: packetValue.opportunityId,
    packetHash: packetValue.packetHash,
    adapterId: "local-fixture",
    actionIntentHash: computeActionIntentHash({
      operation: "auto-apply",
      opportunityId: packetValue.opportunityId,
      packetHash: packetValue.packetHash,
      adapterId: "local-fixture",
      reversibilityTag: "R3"
    }),
    allowedFields: ["application-packet"]
  }, evaluatorApproverKeyPair.privateKey);
}

function forcedScoreApproval(dimensions: ReturnType<typeof demoDimensions>) {
  const opportunityId = "OPP-DEMO-001";
  const subjectHash = sha256(stableStringify(dimensions));
  return createApprovalReference({
    approvalId: "APR-EVAL-FORCED-SCORE",
    operation: "forced-score",
    approvedBy: evaluatorTrustedApprover.approvedBy,
    keyId: evaluatorTrustedApprover.keyId,
    approvedAt: "2026-07-04T00:30:00.000Z",
    expiresAt: "2026-07-04T02:00:00.000Z",
    approvalTextHash: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    opportunityId,
    packetHash: subjectHash,
    adapterId: "rubric",
    actionIntentHash: computeActionIntentHash({
      operation: "forced-score",
      opportunityId,
      packetHash: subjectHash,
      adapterId: "rubric",
      reversibilityTag: "R0"
    }),
    allowedFields: ["forced-score"]
  }, evaluatorApproverKeyPair.privateKey);
}

function noRiskSignals() {
  return {
    captchaPresent: false,
    antiBotDetected: false,
    paymentRequired: false,
    identityCheckRequired: false,
    tosUnclear: false,
    unsupportedLicenseClaim: false,
    credentialFabricationRequested: false
  };
}

function noHighStakesFlags(): HighStakesFlags {
  return Object.fromEntries(HIGH_STAKES_FLAGS.map((flag) => [flag, false])) as HighStakesFlags;
}

function evaluateAutoApply(input: Omit<AutoApplyInput, "documentRoot" | "highStakesFlags" | "ledgerPath" | "now" | "trustedApprovers">) {
  const ledgerPath = path.join(tmpdir(), `vocation-evaluator-${process.pid}-${randomUUID()}.jsonl`);
  try {
    return decideAutoApply({
      ...input,
      documentRoot: PACKAGE_ROOT,
      highStakesFlags: noHighStakesFlags(),
      ledgerPath,
      trustedApprovers: [evaluatorTrustedApprover],
      now: EVALUATOR_NOW
    });
  } finally {
    rmSync(ledgerPath, { force: true });
  }
}

export const EVALUATOR_TESTS: EvaluatorCase[] = [
  {
    id: "EV-001",
    name: "mode list includes auto apply config",
    run: () => MODE_NAMES.includes("/auto-apply-config")
  },
  {
    id: "EV-002",
    name: "schema files compile",
    run: () => validateAllSchemaFiles().valid
  },
  {
    id: "EV-003",
    name: "rubric has 20 dimensions",
    run: () => scoreOpportunity({ dimensions: demoDimensions() }).dimensions.length === 20
  },
  {
    id: "EV-004",
    name: "duplicate dimension ids throw",
    run: () => {
      const dimensions = demoDimensions();
      const first = dimensions[0];
      if (!first) {
        return false;
      }
      dimensions[1] = { ...first };
      try {
        scoreOpportunity({ dimensions });
        return false;
      } catch {
        return true;
      }
    }
  },
  {
    id: "EV-005",
    name: "forced score remains low confidence",
    run: () => {
      const dimensions = demoDimensions();
      return scoreOpportunity({
        dimensions,
        forced: true,
        opportunityId: "OPP-DEMO-001",
        approvalReference: forcedScoreApproval(dimensions),
        trustedApprovers: [evaluatorTrustedApprover],
        now: EVALUATOR_NOW
      }).confidence === "Low";
    }
  },
  {
    id: "EV-006",
    name: "high stakes deep fit sets certainty gate",
    run: () => runDeepFit({ dimensions: demoDimensions(), highStakesFlags: { immigrationSensitive: true } }).highStakesCertaintyGate
  },
  {
    id: "EV-007",
    name: "kill switch blocks first",
    run: () => {
      const config = engageKillSwitch({ ...defaultAutoApplyConfig(), enabled: true, mode: "auto" }, "tester", "test");
      return evaluateAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "local-fixture", approvalReference: approvalReference(), riskSignals: noRiskSignals() }).blockedBy === "kill-switch-engaged";
    }
  },
  {
    id: "EV-008",
    name: "unverified packet claim blocks",
    run: () => !validateApplicationPacket(packet("unverified"), demoGraph(), { documentRoot: PACKAGE_ROOT, now: EVALUATOR_NOW }).valid
  },
  {
    id: "EV-009",
    name: "R4 blocks auto apply",
    run: () => {
      const config = { ...defaultAutoApplyConfig(), enabled: true, mode: "auto" as const };
      return evaluateAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R4", adapterId: "local-fixture", approvalReference: approvalReference(), riskSignals: noRiskSignals() }).blockedBy === "r4-not-auto-submittable";
    }
  },
  {
    id: "EV-010",
    name: "state key encoding removes unsafe separators",
    run: () => !encodeStateKey("probe:with:colons").includes(":")
  },
  {
    id: "EV-011",
    name: "product identity is VocationOS",
    run: () => PRODUCT_NAME === "VocationOS"
  },
  {
    id: "EV-012",
    name: "weak evidence precise score is rejected",
    run: () => {
      const dimensions = demoDimensions();
      const first = dimensions[0];
      if (!first) {
        return false;
      }
      dimensions[0] = { ...first, evidenceStatus: "unverified", score: 50 };
      try {
        scoreOpportunity({ dimensions });
        return false;
      } catch {
        return true;
      }
    }
  },
  {
    id: "EV-013",
    name: "approval is required for allowed auto apply",
    run: () => {
      const config = { ...defaultAutoApplyConfig(), enabled: true, mode: "auto" as const };
      return evaluateAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "local-fixture", riskSignals: noRiskSignals() }).blockedBy === "approval-required";
    }
  },
  {
    id: "EV-014",
    name: "unshipped execution adapter blocks before config allowlist",
    run: () => {
      const config = { ...defaultAutoApplyConfig(), enabled: true, mode: "auto" as const };
      return evaluateAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "unknown", approvalReference: approvalReference(), riskSignals: noRiskSignals() }).blockedBy === "execution-adapter-not-shipped";
    }
  },
  {
    id: "EV-015",
    name: "theory registry is internally consistent",
    run: () => validateTheoryRegistry().valid
  },
  {
    id: "EV-016",
    name: "VocationBench materializes the committed fixture scale",
    run: () => {
      const manifest = createVocationBenchManifest(EVALUATOR_NOW);
      return manifest.profileCount === 500 && manifest.opportunityCount === 1000 && manifest.adversarialCaseCount === 200 && manifest.proofCaseCount === 100;
    }
  },
  {
    id: "EV-017",
    name: "Career Digital Twin validates synthetic state",
    run: () => createCareerTwin("synthetic", [], [], EVALUATOR_NOW).profileScope === "synthetic"
  },
  {
    id: "EV-018",
    name: "R3 packet cannot opt out of approval",
    run: () => {
      const base = packet();
      const packetWithoutApproval = { ...base, approvalRequired: false };
      packetWithoutApproval.packetHash = computePacketHash(packetWithoutApproval);
      const config = { ...defaultAutoApplyConfig(), enabled: true, mode: "auto" as const };
      return evaluateAutoApply({ config, packet: packetWithoutApproval, claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "local-fixture", riskSignals: noRiskSignals() }).blockedBy === "approval-required";
    }
  },
  {
    id: "EV-019",
    name: "incomplete risk observations fail closed",
    run: () => {
      const config = { ...defaultAutoApplyConfig(), enabled: true, mode: "auto" as const };
      return evaluateAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "local-fixture", approvalReference: approvalReference(), riskSignals: {} as ReturnType<typeof noRiskSignals> }).blockedBy === "risk-signals-incomplete";
    }
  }
];

export function runEvaluator(): { passed: number; total: number; failures: string[]; verdict: string } {
  const failures = EVALUATOR_TESTS.filter((test) => !test.run()).map((test) => `${test.id} ${test.name}`);
  return {
    passed: EVALUATOR_TESTS.length - failures.length,
    total: EVALUATOR_TESTS.length,
    failures,
    verdict: failures.length === 0 ? "PASS" : "FAIL"
  };
}
