import { decideAutoApply, defaultAutoApplyConfig, engageKillSwitch } from "./auto-apply.js";
import { validateApplicationPacket } from "./claim-graph.js";
import { computeClaimTextHash, computePacketHash } from "./hash.js";
import { runDeepFit } from "./modes.js";
import { createOpportunityRecord, evaluateOpportunityIntake } from "./opportunity.js";
import { demoDimensions, scoreOpportunity } from "./rubric.js";
import { validateAllSchemaFiles } from "./schema.js";
import { encodeStateKey } from "./state.js";
import { buildSubmissionProof, evaluateSubmissionProof } from "./submission-proof.js";
import { MODE_NAMES, PRODUCT_NAME, type ApplicationPacket, type ClaimGraph } from "./types.js";

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
    documents: [{ kind: "cv", contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
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

function approvalReference() {
  return {
    approvalId: "APR-EVAL-001",
    approvedBy: "evaluator",
    approvedAt: "2026-07-04T00:00:00.000Z",
    approvalTextHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555"
  };
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
    run: () => scoreOpportunity({ dimensions: demoDimensions(), forced: true, approvalReference: approvalReference() }).confidence === "Low"
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
      return decideAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "local-fixture", approvalReference: approvalReference(), riskSignals: noRiskSignals(), dailyUsageCount: 0 }).blockedBy === "kill-switch-engaged";
    }
  },
  {
    id: "EV-008",
    name: "unverified packet claim blocks",
    run: () => !validateApplicationPacket(packet("unverified"), demoGraph()).valid
  },
  {
    id: "EV-009",
    name: "R4 blocks auto apply",
    run: () => {
      const config = { ...defaultAutoApplyConfig(), enabled: true, mode: "auto" as const };
      return decideAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R4", adapterId: "local-fixture", approvalReference: approvalReference(), riskSignals: noRiskSignals(), dailyUsageCount: 0 }).blockedBy === "r4-not-auto-submittable";
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
      return decideAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "local-fixture", riskSignals: noRiskSignals(), dailyUsageCount: 0 }).blockedBy === "approval-required";
    }
  },
  {
    id: "EV-014",
    name: "adapter allowlist blocks unknown adapter",
    run: () => {
      const config = { ...defaultAutoApplyConfig(), enabled: true, mode: "auto" as const };
      return decideAutoApply({ config, packet: packet(), claimGraph: demoGraph(), reversibilityTag: "R3", adapterId: "unknown", approvalReference: approvalReference(), riskSignals: noRiskSignals(), dailyUsageCount: 0 }).blockedBy === "adapter-not-allowlisted";
    }
  },
  {
    id: "EV-015",
    name: "explicit remote opportunity passes intake",
    run: () => {
      const opportunity = createOpportunityRecord({
        source: "manual",
        sourceId: "evaluator-remote",
        sourceUrl: "https://jobs.example.test/evaluator-remote",
        applyUrl: "https://jobs.example.test/evaluator-remote/apply",
        company: "Synthetic Labs",
        roleTitle: "Responsible AI Product Lead",
        locationText: "Remote, Europe",
        remotePolicy: "remote",
        applicantLocationRequirements: ["Europe"],
        descriptionText: "A substantive synthetic opportunity for responsible AI product evaluation and evidence grounded operations.",
        postedAt: "2026-07-01T00:00:00.000Z",
        capturedAt: "2026-07-10T00:00:00.000Z",
        extractionConfidence: "high",
        sourcePayload: { synthetic: true }
      });
      return evaluateOpportunityIntake(opportunity, {
        requiresRemote: true,
        requireExplicitApplicantLocation: true,
        candidateRegions: ["Europe"],
        maxAgeDays: 45,
        minimumDescriptionCharacters: 40,
        existingFingerprints: [],
        evaluatedAt: "2026-07-10T00:00:00.000Z"
      }).status === "accepted";
    }
  },
  {
    id: "EV-016",
    name: "unknown remote eligibility requires review",
    run: () => {
      const opportunity = createOpportunityRecord({
        source: "manual",
        sourceId: "evaluator-unknown-location",
        sourceUrl: "https://jobs.example.test/evaluator-unknown-location",
        applyUrl: "https://jobs.example.test/evaluator-unknown-location/apply",
        company: "Synthetic Labs",
        roleTitle: "AI Research Lead",
        locationText: "Remote",
        remotePolicy: "remote",
        applicantLocationRequirements: [],
        descriptionText: "A substantive synthetic opportunity for AI research, evaluation, governance, and applied safety work.",
        postedAt: "2026-07-01T00:00:00.000Z",
        capturedAt: "2026-07-10T00:00:00.000Z",
        extractionConfidence: "high",
        sourcePayload: { synthetic: true }
      });
      return evaluateOpportunityIntake(opportunity, {
        requiresRemote: true,
        requireExplicitApplicantLocation: true,
        candidateRegions: ["Europe"],
        maxAgeDays: 45,
        minimumDescriptionCharacters: 40,
        existingFingerprints: [],
        evaluatedAt: "2026-07-10T00:00:00.000Z"
      }).status === "manual_review";
    }
  },
  {
    id: "EV-017",
    name: "verification code is not submission proof",
    run: () => {
      const proof = buildSubmissionProof({
        opportunityId: "OPP-DEMO-001",
        kind: "receipt-email",
        capturedAt: "2026-07-10T00:00:00.000Z",
        sourcePointer: "redacted:security-code",
        officialRoute: true,
        senderDomain: "example.test",
        indicators: ["Copy this security code and resubmit your application"]
      });
      return evaluateSubmissionProof(proof).status === "rejected";
    }
  },
  {
    id: "EV-018",
    name: "official confirmation can close an application",
    run: () => {
      const proof = buildSubmissionProof({
        opportunityId: "OPP-DEMO-001",
        kind: "confirmation-page",
        capturedAt: "2026-07-10T00:00:00.000Z",
        sourcePointer: "redacted:confirmation",
        officialRoute: true,
        indicators: ["Thank you for applying. Your application has been received."]
      });
      return evaluateSubmissionProof(proof).status === "confirmed";
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
