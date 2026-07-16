import { generateKeyPairSync } from "node:crypto";
import { createApprovalReference, type TrustedApprover } from "../approval.js";
import { decideAutoApply, defaultAutoApplyConfig } from "../auto-apply.js";
import { validateDocumentAstV2, type DocumentAstV2 } from "../documents/document-ast-v2.js";
import { evaluateDedupePair } from "../discovery/dedupe.js";
import { assessSourceLiveness } from "../discovery/liveness.js";
import { createSourceObservation, type SourceAvailability } from "../discovery/source-observation.js";
import {
  computeActionIntentHash,
  computeClaimTextHash,
  computePacketHash,
  sha256,
  stableStringify
} from "../hash.js";
import {
  createSubmissionProof,
  evaluateSubmissionProof,
  type SubmissionObservationDraft,
  type SubmissionProof,
  type SubmissionProofExpectation,
  type SubmissionProofKind,
  type TrustedCollector
} from "../submission-proof.js";
import {
  HIGH_STAKES_FLAGS,
  type ActionLedgerEntry,
  type ApplicationPacket,
  type ApprovalReference,
  type AutomationRiskSignals,
  type AutoApplyConfig,
  type Claim,
  type ClaimGraph,
  type HighStakesFlags,
  type ReversibilityTag
} from "../types.js";
import {
  VOCATION_BENCH_FIXTURE_FILES,
  type VocationBenchCalibrationFixtureSuite,
  type VocationBenchClaimTraceCaseFixture,
  type VocationBenchClaimTraceFixtureSuite,
  type VocationBenchDedupeFixtureSuite,
  type VocationBenchExecutableFixtures,
  type VocationBenchLivenessFixtureSuite,
  type VocationBenchProofCaseFixture,
  type VocationBenchSafetyCaseFixture,
  type VocationBenchSafetyProofFixtureSuite
} from "./vocation-bench-fixtures.js";
import { brierScore, expectedCalibrationError, f1Score, type RankedItem } from "./vocation-bench-metrics.js";

export type VocationBenchSuiteId = "liveness" | "dedupe" | "safety-proof" | "claim-trace" | "calibration";

export interface VocationBenchExecutableThresholds {
  claimTraceCoverage: number;
  falseAllowRate: number;
  falseConfirmationRate: number;
  dedupeF1: number;
  livenessPrecision: number;
  maximumCalibrationError: number;
  fixtureConformance: number;
  minimumCalibrationSamples: number;
}

export interface VocationBenchCaseResult {
  caseId: string;
  expected: string;
  actual: string;
  passed: boolean;
  details: string[];
}

export interface VocationBenchThresholdVerdict {
  metric: string;
  direction: "at-least" | "at-most" | "equals";
  threshold: number;
  actual: number;
  passed: boolean;
}

export interface VocationBenchSuiteResult {
  suiteId: VocationBenchSuiteId;
  fixtureFile: string;
  fixtureHash: string;
  caseCount: number;
  metrics: Record<string, number>;
  thresholds: VocationBenchThresholdVerdict[];
  caseResults: VocationBenchCaseResult[];
  failures: string[];
  passed: boolean;
}

export interface VocationBenchSuiteExecution {
  fixtureHashes: Record<VocationBenchSuiteId, string>;
  fixtureSetHash: string;
  suites: {
    liveness: VocationBenchSuiteResult;
    dedupe: VocationBenchSuiteResult;
    safetyProof: VocationBenchSuiteResult;
    claimTrace: VocationBenchSuiteResult;
    calibration: VocationBenchSuiteResult;
  };
}

const BENCHMARK_CLAIM_TEXT = "The synthetic operator completed a reproducible career safety project.";
const FIXED_HASH = "sha256:5555555555555555555555555555555555555555555555555555555555555555";

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function canonicalFixtureHash(value: unknown): string {
  return sha256(stableStringify(value));
}

function thresholdVerdict(
  metric: string,
  direction: VocationBenchThresholdVerdict["direction"],
  actual: number,
  threshold: number
): VocationBenchThresholdVerdict {
  const passed = direction === "at-least"
    ? actual >= threshold
    : direction === "at-most"
      ? actual <= threshold
      : actual === threshold;
  return { metric, direction, threshold, actual, passed };
}

function suiteResult(input: {
  suiteId: VocationBenchSuiteId;
  fixtureFile: string;
  fixtureHash: string;
  caseCount: number;
  metrics: Record<string, number>;
  thresholds: VocationBenchThresholdVerdict[];
  caseResults: VocationBenchCaseResult[];
}): VocationBenchSuiteResult {
  const failures = [
    ...input.thresholds.filter((verdict) => !verdict.passed).map((verdict) => `threshold:${verdict.metric}`),
    ...input.caseResults.filter((result) => !result.passed).map((result) => `case:${result.caseId}`)
  ];
  return {
    ...input,
    failures,
    passed: failures.length === 0
  };
}

function classificationAccuracy(results: readonly VocationBenchCaseResult[]): number {
  return results.length === 0 ? 0 : roundMetric(results.filter((result) => result.passed).length / results.length);
}

function availabilityStatus(availability: SourceAvailability): number | null {
  if (availability === "available" || availability === "parse-error") return 200;
  if (availability === "not-found") return 404;
  if (availability === "gone") return 410;
  if (availability === "access-denied") return 403;
  if (availability === "rate-limited") return 429;
  return null;
}

function runLivenessSuite(
  fixture: VocationBenchLivenessFixtureSuite,
  thresholds: VocationBenchExecutableThresholds
): VocationBenchSuiteResult {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  const now = new Date(fixture.assessedAt);
  const caseResults = fixture.cases.map((entry) => {
    const observations = entry.observations.map((observation, index) => {
      const responseRetrieved = observation.availability === "available" || observation.availability === "parse-error";
      const requestUrl = `https://boards-api.greenhouse.io/v1/boards/vocation-bench/jobs/${entry.caseId.toLowerCase()}-${index + 1}`;
      return createSourceObservation({
        providerId: "greenhouse",
        providerManifestVersion: "1.0.0",
        sourceKey: `vocation-bench:${entry.caseId}`,
        requestedUrl: requestUrl,
        finalUrl: responseRetrieved ? requestUrl : null,
        observedAt: observation.observedAt,
        availability: observation.availability,
        httpStatus: availabilityStatus(observation.availability),
        contentType: responseRetrieved ? "application/json" : null,
        bodyDigest: responseRetrieved ? sha256(`${entry.caseId}:${index}`) : null,
        cacheState: "bypass",
        redirectCount: 0,
        fields: observation.availability === "available"
          ? [{
              field: "title",
              value: `Synthetic role ${entry.caseId}`,
              confidence: "high",
              evidencePointer: `fixture:${entry.caseId}:${index}`
            }]
          : [],
        uncertainty: observation.uncertainty
      });
    });
    const actual = assessSourceLiveness(observations, undefined, now).state;
    const expectedLive = entry.expectedState === "live";
    const actualLive = actual === "live";
    if (expectedLive && actualLive) truePositive += 1;
    else if (!expectedLive && actualLive) falsePositive += 1;
    else if (expectedLive) falseNegative += 1;
    else trueNegative += 1;
    return {
      caseId: entry.caseId,
      expected: entry.expectedState,
      actual,
      passed: actual === entry.expectedState,
      details: []
    };
  });
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  const metrics = {
    precision: roundMetric(precision),
    recall: roundMetric(recall),
    stateAccuracy: classificationAccuracy(caseResults),
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative
  };
  const verdicts = [
    thresholdVerdict("precision", "at-least", metrics.precision, thresholds.livenessPrecision),
    thresholdVerdict("stateAccuracy", "at-least", metrics.stateAccuracy, thresholds.fixtureConformance)
  ];
  return suiteResult({
    suiteId: "liveness",
    fixtureFile: VOCATION_BENCH_FIXTURE_FILES.liveness,
    fixtureHash: canonicalFixtureHash(fixture),
    caseCount: fixture.cases.length,
    metrics,
    thresholds: verdicts,
    caseResults
  });
}

function runDedupeSuite(
  fixture: VocationBenchDedupeFixtureSuite,
  thresholds: VocationBenchExecutableThresholds
): VocationBenchSuiteResult {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  const caseResults = fixture.cases.map((entry) => {
    const actual = evaluateDedupePair(entry.left, entry.right).outcome;
    const expectedDuplicate = entry.expectedOutcome === "merge";
    const actualDuplicate = actual === "merge";
    if (expectedDuplicate && actualDuplicate) truePositive += 1;
    else if (!expectedDuplicate && actualDuplicate) falsePositive += 1;
    else if (expectedDuplicate) falseNegative += 1;
    else trueNegative += 1;
    return {
      caseId: entry.caseId,
      expected: entry.expectedOutcome,
      actual,
      passed: actual === entry.expectedOutcome,
      details: []
    };
  });
  const score = roundMetric(f1Score({ truePositive, falsePositive, falseNegative }));
  const metrics = {
    f1: score,
    outcomeAccuracy: classificationAccuracy(caseResults),
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative
  };
  const verdicts = [
    thresholdVerdict("f1", "at-least", metrics.f1, thresholds.dedupeF1),
    thresholdVerdict("outcomeAccuracy", "at-least", metrics.outcomeAccuracy, thresholds.fixtureConformance)
  ];
  return suiteResult({
    suiteId: "dedupe",
    fixtureFile: VOCATION_BENCH_FIXTURE_FILES.dedupe,
    fixtureHash: canonicalFixtureHash(fixture),
    caseCount: fixture.cases.length,
    metrics,
    thresholds: verdicts,
    caseResults
  });
}

function benchmarkGraph(generatedAt: string): ClaimGraph {
  return {
    profileId: "DEMO-VB-OPERATOR",
    profileScope: "synthetic",
    generatedAt,
    graphVersion: "0.6.0",
    claims: [{
      claimId: "CLM-VB-001",
      text: BENCHMARK_CLAIM_TEXT,
      canonicalTextHash: computeClaimTextHash(BENCHMARK_CLAIM_TEXT),
      claimType: "project",
      evidenceStatus: "verified",
      sourceType: "operator-supplied",
      sourcePointer: "fixture:vocation-bench:claim-001",
      verifiedDate: generatedAt.slice(0, 10),
      recencyRequired: false,
      publiclyAssertable: true,
      allowedInCv: true,
      allowedInOutreach: true,
      allowedInAutoApply: true
    }],
    validationSummary: { verifiedClaims: 1, unverifiedClaims: 0, privateClaims: 0 }
  };
}

function benchmarkPacket(generatedAt: string): ApplicationPacket {
  const value: ApplicationPacket = {
    opportunityId: "OPP-VB-001",
    claims: [{
      claimId: "CLM-VB-001",
      text: BENCHMARK_CLAIM_TEXT,
      sourceClaimTextHash: computeClaimTextHash(BENCHMARK_CLAIM_TEXT),
      evidenceStatus: "verified",
      sourcePointer: "fixture:vocation-bench:claim-001",
      publiclyAssertable: true
    }],
    documents: [],
    tosCompliant: true,
    generatedAt,
    packetHash: FIXED_HASH,
    approvalRequired: true
  };
  return { ...value, packetHash: computePacketHash(value) };
}

function noRiskSignals(): AutomationRiskSignals {
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

function enabledAutoConfig(): AutoApplyConfig {
  const defaults = defaultAutoApplyConfig();
  return {
    ...defaults,
    enabled: true,
    mode: "auto",
    killSwitch: { ...defaults.killSwitch },
    rateLimit: { maxPerDay: 5 },
    adapterAllowlist: [...defaults.adapterAllowlist],
    perOpportunity: {},
    exclusionRules: [...defaults.exclusionRules]
  };
}

function createSafetyApproval(
  packet: ApplicationPacket,
  adapterId: string,
  reversibilityTag: ReversibilityTag,
  evaluatedAt: Date,
  approver: TrustedApprover,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]
): ApprovalReference {
  return createApprovalReference({
    approvalId: "APR-VB-001",
    operation: "auto-apply",
    approvedBy: approver.approvedBy,
    keyId: approver.keyId,
    approvedAt: new Date(evaluatedAt.getTime() - 60_000).toISOString(),
    expiresAt: new Date(evaluatedAt.getTime() + 3_600_000).toISOString(),
    approvalTextHash: FIXED_HASH,
    opportunityId: packet.opportunityId,
    packetHash: packet.packetHash,
    adapterId,
    actionIntentHash: computeActionIntentHash({
      operation: "auto-apply",
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId,
      reversibilityTag
    }),
    allowedFields: ["application-packet"]
  }, privateKey);
}

function rateLimitEntry(timestamp: string): ActionLedgerEntry {
  return {
    actionId: "ACT-VB-RATE-LIMIT-001",
    timestamp,
    mode: "/auto-apply-config",
    opportunityId: "OPP-VB-PRIOR",
    reversibilityTag: "R3",
    evidenceGatePassed: true,
    approvalRequired: true,
    approvalReceived: true,
    highStakesGatePassed: true,
    result: "submitted"
  };
}

function runSafetyCase(
  entry: VocationBenchSafetyCaseFixture,
  evaluatedAt: Date,
  approver: TrustedApprover,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]
): VocationBenchCaseResult {
  let config = enabledAutoConfig();
  let graph = benchmarkGraph(evaluatedAt.toISOString());
  let packet = benchmarkPacket(evaluatedAt.toISOString());
  let adapterId = "local-fixture";
  let reversibilityTag: ReversibilityTag = "R3";
  let riskSignals: AutomationRiskSignals | undefined = noRiskSignals();
  let highStakesFlags: HighStakesFlags | undefined = noHighStakesFlags();
  let authoritativeLedgerEntries: ActionLedgerEntry[] = [];
  let omitApproval = false;
  let invalidateApproval = false;

  switch (entry.scenario) {
    case "valid-approved": break;
    case "captcha": riskSignals.captchaPresent = true; break;
    case "anti-bot": riskSignals.antiBotDetected = true; break;
    case "payment": riskSignals.paymentRequired = true; break;
    case "identity-check": riskSignals.identityCheckRequired = true; break;
    case "tos-unclear": riskSignals.tosUnclear = true; break;
    case "unsupported-license-claim": riskSignals.unsupportedLicenseClaim = true; break;
    case "credential-fabrication": riskSignals.credentialFabricationRequested = true; break;
    case "kill-switch":
      config = { ...config, killSwitch: { available: true, engaged: true } };
      break;
    case "r4": reversibilityTag = "R4"; break;
    case "missing-risk-signals": riskSignals = undefined; break;
    case "incomplete-risk-signals":
      riskSignals = { captchaPresent: false } as AutomationRiskSignals;
      break;
    case "high-stakes":
      highStakesFlags = { ...noHighStakesFlags(), licensingSensitive: true };
      break;
    case "missing-high-stakes": highStakesFlags = undefined; break;
    case "unshipped-adapter": adapterId = "unshipped-fixture"; break;
    case "rate-limit-exhausted":
      config = { ...config, rateLimit: { maxPerDay: 1 } };
      authoritativeLedgerEntries = [rateLimitEntry(evaluatedAt.toISOString())];
      break;
    case "cooldown-active":
      config = {
        ...config,
        rateLimit: { maxPerDay: 5, cooldownUntil: new Date(evaluatedAt.getTime() + 60_000).toISOString() }
      };
      break;
    case "missing-approval": omitApproval = true; break;
    case "invalid-approval": invalidateApproval = true; break;
    case "packet-tos-noncompliant": {
      const changed = { ...packet, tosCompliant: false };
      packet = { ...changed, packetHash: computePacketHash(changed) };
      break;
    }
    case "non-synthetic-profile": graph = { ...graph, profileScope: "local-private" }; break;
  }

  let approval = createSafetyApproval(packet, adapterId, reversibilityTag, evaluatedAt, approver, privateKey);
  if (invalidateApproval) {
    const firstCharacter = approval.signature.startsWith("A") ? "B" : "A";
    approval = { ...approval, signature: `${firstCharacter}${approval.signature.slice(1)}` };
  }
  const decision = decideAutoApply({
    config,
    packet,
    claimGraph: graph,
    reversibilityTag,
    adapterId,
    trustedApprovers: [approver],
    authoritativeLedgerEntries,
    actionId: `ACT-${entry.caseId}`,
    now: evaluatedAt,
    ...(riskSignals ? { riskSignals } : {}),
    ...(highStakesFlags ? { highStakesFlags } : {}),
    ...(!omitApproval ? { approvalReference: approval } : {})
  });
  const actualBlockedBy = decision.blockedBy ?? null;
  const allowedMatches = decision.allowed === entry.expectedAllowed;
  const blockerMatches = actualBlockedBy === entry.expectedBlockedBy;
  return {
    caseId: entry.caseId,
    expected: entry.expectedAllowed ? "allowed" : `blocked:${entry.expectedBlockedBy ?? "unspecified"}`,
    actual: decision.allowed ? "allowed" : `blocked:${actualBlockedBy ?? "unspecified"}`,
    passed: allowedMatches && blockerMatches,
    details: [...decision.reasons]
  };
}

function proofKind(scenario: VocationBenchProofCaseFixture["scenario"]): SubmissionProofKind {
  if (scenario === "ats-missing-reference" || scenario === "ats-valid-reference") return "ats-dashboard";
  if (scenario.startsWith("sent-items")) return "sent-items";
  return "confirmation-page";
}

function runProofCase(
  entry: VocationBenchProofCaseFixture,
  evaluatedAt: Date,
  collectorKeyPair: ReturnType<typeof generateKeyPairSync>,
  alternateKeyPair: ReturnType<typeof generateKeyPairSync>
): VocationBenchCaseResult {
  const submittedAt = new Date(evaluatedAt.getTime() - 600_000);
  let capturedAt = new Date(evaluatedAt.getTime() - 300_000);
  const kind = proofKind(entry.scenario);
  let indicators = ["Application has been received"];
  let referenceId: string | null = kind === "ats-dashboard" ? "ATS-VB-001" : null;
  let recipientDomain: string | null = kind === "sent-items" ? "example.org" : null;
  let attachmentCount: number | null = kind === "sent-items" ? 1 : null;
  let sentAt: string | null = kind === "sent-items"
    ? new Date(evaluatedAt.getTime() - 420_000).toISOString()
    : null;
  let signingKey = collectorKeyPair.privateKey;
  let trustedCollectors: TrustedCollector[];

  if (entry.scenario === "missing-positive-indicator") indicators = [];
  if (entry.scenario === "negative-completion-signal") indicators = ["Application was not submitted"];
  if (entry.scenario === "capture-before-window") capturedAt = new Date(evaluatedAt.getTime() - 1_800_000);
  if (entry.scenario === "ats-missing-reference") referenceId = null;
  if (entry.scenario === "sent-items-missing-attachment") attachmentCount = 0;
  if (entry.scenario === "sent-items-missing-recipient") recipientDomain = null;
  if (entry.scenario === "sent-items-invalid-time") {
    sentAt = new Date(evaluatedAt.getTime() - 2_400_000).toISOString();
  }
  if (entry.scenario === "invalid-signature") signingKey = alternateKeyPair.privateKey;

  const draft: SubmissionObservationDraft = {
    collectorId: "COL-VOCATION-BENCH",
    collectorVersion: "1.0.0",
    keyId: "KEY-VB-COLLECTOR-001",
    attemptId: "ATT-0001-00000000-0000-4000-8000-000000000001",
    actionIntentHash: FIXED_HASH,
    opportunityId: "OPP-VB-001",
    packetHash: FIXED_HASH,
    adapterId: "local-fixture",
    kind,
    capturedAt: capturedAt.toISOString(),
    sourceDomain: "jobs.example.org",
    sourcePointer: `proof:vocation-bench:${entry.caseId}`,
    indicators,
    recipientDomain,
    attachmentCount,
    referenceId,
    sentAt,
    payloadHash: sha256(`payload:${entry.caseId}`)
  };
  let proof: SubmissionProof = createSubmissionProof(draft, signingKey);
  const trustedCollector: TrustedCollector = {
    collectorId: draft.collectorId,
    keyId: draft.keyId,
    publicKeyPem: collectorKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedAdapters: [draft.adapterId],
    allowedSourceDomains: [draft.sourceDomain],
    allowedKinds: [kind]
  };
  trustedCollectors = [trustedCollector];
  const expectation: SubmissionProofExpectation = {
    attemptId: draft.attemptId,
    actionIntentHash: draft.actionIntentHash,
    opportunityId: draft.opportunityId,
    packetHash: draft.packetHash,
    adapterId: draft.adapterId,
    submittedAt: submittedAt.toISOString(),
    evaluatedAt: evaluatedAt.toISOString()
  };

  if (entry.scenario === "untrusted-collector") trustedCollectors = [];
  if (entry.scenario === "binding-mismatch") expectation.packetHash = sha256("different-packet");
  if (entry.scenario === "tampered-receipt") proof = { ...proof, receiptHash: sha256("tampered-receipt") };
  if (entry.scenario === "source-domain-mismatch") trustedCollector.allowedSourceDomains = ["other.example.org"];
  if (entry.scenario === "adapter-not-allowed") trustedCollector.allowedAdapters = [];
  if (entry.scenario === "kind-not-allowed") trustedCollector.allowedKinds = [];

  const evaluation = evaluateSubmissionProof(proof, trustedCollectors, expectation);
  return {
    caseId: entry.caseId,
    expected: entry.expectedStatus,
    actual: evaluation.status,
    passed: evaluation.status === entry.expectedStatus,
    details: [...evaluation.reasons]
  };
}

function runSafetyProofSuite(
  fixture: VocationBenchSafetyProofFixtureSuite,
  thresholds: VocationBenchExecutableThresholds
): VocationBenchSuiteResult {
  const evaluatedAt = new Date(fixture.evaluatedAt);
  const approverKeyPair = generateKeyPairSync("ed25519");
  const approver: TrustedApprover = {
    approvedBy: "vocation-bench",
    keyId: "KEY-VB-APPROVER-001",
    publicKeyPem: approverKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
  };
  const collectorKeyPair = generateKeyPairSync("ed25519");
  const alternateKeyPair = generateKeyPairSync("ed25519");
  const safetyResults = fixture.safetyCases.map((entry) =>
    runSafetyCase(entry, evaluatedAt, approver, approverKeyPair.privateKey)
  );
  const proofResults = fixture.proofCases.map((entry) =>
    runProofCase(entry, evaluatedAt, collectorKeyPair, alternateKeyPair)
  );
  const falseAllowDenominator = fixture.safetyCases.filter((entry) => !entry.expectedAllowed).length;
  const falseAllows = fixture.safetyCases.filter(
    (entry, index) => !entry.expectedAllowed && safetyResults[index]?.actual === "allowed"
  ).length;
  const falseConfirmationDenominator = fixture.proofCases.filter((entry) => entry.expectedStatus !== "confirmed").length;
  const falseConfirmations = fixture.proofCases.filter(
    (entry, index) => entry.expectedStatus !== "confirmed" && proofResults[index]?.actual === "confirmed"
  ).length;
  const falseAllowRate = falseAllowDenominator === 0 ? 1 : falseAllows / falseAllowDenominator;
  const falseConfirmationRate = falseConfirmationDenominator === 0
    ? 1
    : falseConfirmations / falseConfirmationDenominator;
  const metrics = {
    falseAllowRate: roundMetric(falseAllowRate),
    falseConfirmationRate: roundMetric(falseConfirmationRate),
    safetyClassificationAccuracy: classificationAccuracy(safetyResults),
    proofClassificationAccuracy: classificationAccuracy(proofResults),
    falseAllows,
    falseConfirmations,
    adversarialSafetyCaseCount: falseAllowDenominator,
    nonConfirmableProofCaseCount: falseConfirmationDenominator
  };
  const verdicts = [
    thresholdVerdict("falseAllowRate", "at-most", metrics.falseAllowRate, thresholds.falseAllowRate),
    thresholdVerdict(
      "falseConfirmationRate",
      "at-most",
      metrics.falseConfirmationRate,
      thresholds.falseConfirmationRate
    ),
    thresholdVerdict(
      "safetyClassificationAccuracy",
      "at-least",
      metrics.safetyClassificationAccuracy,
      thresholds.fixtureConformance
    ),
    thresholdVerdict(
      "proofClassificationAccuracy",
      "at-least",
      metrics.proofClassificationAccuracy,
      thresholds.fixtureConformance
    )
  ];
  return suiteResult({
    suiteId: "safety-proof",
    fixtureFile: VOCATION_BENCH_FIXTURE_FILES.safetyProof,
    fixtureHash: canonicalFixtureHash(fixture),
    caseCount: safetyResults.length + proofResults.length,
    metrics,
    thresholds: verdicts,
    caseResults: [...safetyResults, ...proofResults]
  });
}

function benchmarkDocument(generatedAt: string): DocumentAstV2 {
  return {
    schemaVersion: 2,
    documentId: "DOC-VB-001",
    kind: "cv",
    profileId: "DEMO-VB-OPERATOR",
    opportunityId: "OPP-VB-001",
    titleKey: "cv",
    locale: "en",
    generatedAt,
    layout: { pageSize: "A4", marginPoints: 48, bodyFontSize: 10.5 },
    sections: [{
      sectionId: "SEC-VB-EXPERIENCE",
      labelKey: "experience",
      nodes: [{
        nodeId: "NODE-VB-CLAIM-001",
        type: "bullet",
        bindingMode: "verbatim-claim",
        text: BENCHMARK_CLAIM_TEXT,
        claimIds: ["CLM-VB-001"],
        textHash: computeClaimTextHash(BENCHMARK_CLAIM_TEXT)
      }]
    }]
  };
}

function replaceClaim(graph: ClaimGraph, claim: Claim): ClaimGraph {
  return {
    ...graph,
    claims: [claim],
    validationSummary: {
      verifiedClaims: claim.evidenceStatus === "verified" ? 1 : 0,
      unverifiedClaims: claim.evidenceStatus === "verified" ? 0 : 1,
      privateClaims: claim.publiclyAssertable ? 0 : 1
    }
  };
}

function runClaimTraceCase(
  entry: VocationBenchClaimTraceCaseFixture,
  evaluatedAt: Date
): VocationBenchCaseResult & { contentNodeCount: number; tracedContentNodeCount: number } {
  let graph = benchmarkGraph(evaluatedAt.toISOString());
  let document = benchmarkDocument(evaluatedAt.toISOString());
  const baseClaim = graph.claims[0]!;
  const node = document.sections[0]!.nodes[0]!;
  if (node.type === "heading") throw new Error("VocationBench claim trace fixture is malformed");

  switch (entry.scenario) {
    case "valid": break;
    case "claim-inflation":
      node.text = `${BENCHMARK_CLAIM_TEXT} It also won an international award.`;
      node.textHash = computeClaimTextHash(node.text);
      break;
    case "missing-claim": node.claimIds = ["CLM-VB-MISSING"]; break;
    case "unverified-claim": {
      const { verifiedDate: _verifiedDate, ...withoutVerifiedDate } = baseClaim;
      graph = replaceClaim(graph, { ...withoutVerifiedDate, evidenceStatus: "unverified" });
      break;
    }
    case "private-claim": graph = replaceClaim(graph, { ...baseClaim, publiclyAssertable: false }); break;
    case "disallowed-use": graph = replaceClaim(graph, { ...baseClaim, allowedInCv: false }); break;
    case "stale-evidence":
      graph = replaceClaim(graph, {
        ...baseClaim,
        verifiedDate: "2026-01-01",
        recencyRequired: true,
        recencyPolicyId: "job-liveness"
      });
      break;
    case "profile-mismatch": document = { ...document, profileId: "DEMO-VB-OTHER" }; break;
    case "canonical-hash-mismatch":
      graph = replaceClaim(graph, { ...baseClaim, canonicalTextHash: sha256("wrong-claim-text") });
      break;
    case "injected-structural-text":
      document = { ...document, title: "Unverified professional title" } as unknown as DocumentAstV2;
      break;
    case "untraced-node": node.claimIds = [] as unknown as [string]; break;
  }

  let actualValid = false;
  let contentNodeCount = 0;
  let tracedContentNodeCount = 0;
  let details: string[] = [];
  try {
    const validation = validateDocumentAstV2(document, graph, evaluatedAt);
    actualValid = validation.valid;
    contentNodeCount = validation.contentNodeCount;
    tracedContentNodeCount = validation.tracedContentNodeCount;
    details = [...validation.reasons];
  } catch (error) {
    details = [error instanceof Error ? error.message : String(error)];
  }
  return {
    caseId: entry.caseId,
    expected: entry.expectedValid ? "valid" : "rejected",
    actual: actualValid ? "valid" : "rejected",
    passed: actualValid === entry.expectedValid,
    details,
    contentNodeCount,
    tracedContentNodeCount
  };
}

function runClaimTraceSuite(
  fixture: VocationBenchClaimTraceFixtureSuite,
  thresholds: VocationBenchExecutableThresholds
): VocationBenchSuiteResult {
  const evaluatedAt = new Date(fixture.evaluatedAt);
  const results = fixture.cases.map((entry) => runClaimTraceCase(entry, evaluatedAt));
  const expectedValidIndexes = fixture.cases
    .map((entry, index) => entry.expectedValid ? index : -1)
    .filter((index) => index >= 0);
  const contentNodeCount = expectedValidIndexes.reduce(
    (sum, index) => sum + (results[index]?.contentNodeCount ?? 0),
    0
  );
  const tracedContentNodeCount = expectedValidIndexes.reduce(
    (sum, index) => sum + (results[index]?.tracedContentNodeCount ?? 0),
    0
  );
  const adversarialIndexes = fixture.cases
    .map((entry, index) => !entry.expectedValid ? index : -1)
    .filter((index) => index >= 0);
  const rejectedAdversarialCases = adversarialIndexes.filter((index) => results[index]?.actual === "rejected").length;
  const claimTraceCoverage = contentNodeCount === 0 ? 0 : tracedContentNodeCount / contentNodeCount;
  const adversarialDetectionRate = adversarialIndexes.length === 0
    ? 0
    : rejectedAdversarialCases / adversarialIndexes.length;
  const metrics = {
    claimTraceCoverage: roundMetric(claimTraceCoverage),
    caseAccuracy: classificationAccuracy(results),
    adversarialDetectionRate: roundMetric(adversarialDetectionRate),
    contentNodeCount,
    tracedContentNodeCount,
    adversarialCaseCount: adversarialIndexes.length,
    rejectedAdversarialCases
  };
  const verdicts = [
    thresholdVerdict(
      "claimTraceCoverage",
      "equals",
      metrics.claimTraceCoverage,
      thresholds.claimTraceCoverage
    ),
    thresholdVerdict("caseAccuracy", "at-least", metrics.caseAccuracy, thresholds.fixtureConformance)
  ];
  const caseResults = results.map(({ contentNodeCount: _content, tracedContentNodeCount: _traced, ...result }) => result);
  return suiteResult({
    suiteId: "claim-trace",
    fixtureFile: VOCATION_BENCH_FIXTURE_FILES.claimTrace,
    fixtureHash: canonicalFixtureHash(fixture),
    caseCount: fixture.cases.length,
    metrics,
    thresholds: verdicts,
    caseResults
  });
}

function runCalibrationSuite(
  fixture: VocationBenchCalibrationFixtureSuite,
  thresholds: VocationBenchExecutableThresholds
): VocationBenchSuiteResult {
  const predictions: RankedItem[] = fixture.cases.map((entry) => ({
    relevance: 0,
    predictedProbability: entry.predictedProbability,
    observedOutcome: entry.observedOutcome
  }));
  const positives = fixture.cases.filter((entry) => entry.observedOutcome === 1).length;
  const metrics = {
    expectedCalibrationError: roundMetric(expectedCalibrationError(predictions, fixture.bins)),
    brierScore: roundMetric(brierScore(predictions)),
    sampleCount: fixture.cases.length,
    positiveRate: roundMetric(positives / fixture.cases.length),
    bins: fixture.bins
  };
  const verdicts = [
    thresholdVerdict(
      "expectedCalibrationError",
      "at-most",
      metrics.expectedCalibrationError,
      thresholds.maximumCalibrationError
    ),
    thresholdVerdict(
      "sampleCount",
      "at-least",
      metrics.sampleCount,
      thresholds.minimumCalibrationSamples
    )
  ];
  const caseResults = fixture.cases.map((entry) => ({
    caseId: entry.caseId,
    expected: `outcome:${entry.observedOutcome}`,
    actual: `probability:${entry.predictedProbability}`,
    passed: true,
    details: []
  }));
  return suiteResult({
    suiteId: "calibration",
    fixtureFile: VOCATION_BENCH_FIXTURE_FILES.calibration,
    fixtureHash: canonicalFixtureHash(fixture),
    caseCount: fixture.cases.length,
    metrics,
    thresholds: verdicts,
    caseResults
  });
}

export function executeVocationBenchSuites(
  fixtures: VocationBenchExecutableFixtures,
  thresholds: VocationBenchExecutableThresholds
): VocationBenchSuiteExecution {
  const liveness = runLivenessSuite(fixtures.liveness, thresholds);
  const dedupe = runDedupeSuite(fixtures.dedupe, thresholds);
  const safetyProof = runSafetyProofSuite(fixtures.safetyProof, thresholds);
  const claimTrace = runClaimTraceSuite(fixtures.claimTrace, thresholds);
  const calibration = runCalibrationSuite(fixtures.calibration, thresholds);
  const fixtureHashes: Record<VocationBenchSuiteId, string> = {
    liveness: liveness.fixtureHash,
    dedupe: dedupe.fixtureHash,
    "safety-proof": safetyProof.fixtureHash,
    "claim-trace": claimTrace.fixtureHash,
    calibration: calibration.fixtureHash
  };
  return {
    fixtureHashes,
    fixtureSetHash: canonicalFixtureHash(fixtureHashes),
    suites: { liveness, dedupe, safetyProof, claimTrace, calibration }
  };
}
