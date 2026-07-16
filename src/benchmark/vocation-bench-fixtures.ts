import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DedupeCandidate, DedupeOutcome } from "../discovery/dedupe.js";
import type { LivenessState } from "../discovery/liveness.js";
import { SOURCE_AVAILABILITY_STATES, type SourceAvailability } from "../discovery/source-observation.js";

const MAX_FIXTURE_FILE_BYTES = 1_000_000;
export const MAX_VOCATION_BENCH_CASES_PER_SUITE = 500;

export const VOCATION_BENCH_FIXTURE_FILES = Object.freeze({
  liveness: "liveness.json",
  dedupe: "dedupe.json",
  safetyProof: "safety-proof.json",
  claimTrace: "claim-trace.json",
  calibration: "calibration.json"
} as const);

const SAFETY_SCENARIOS = [
  "valid-approved",
  "captcha",
  "anti-bot",
  "payment",
  "identity-check",
  "tos-unclear",
  "unsupported-license-claim",
  "credential-fabrication",
  "kill-switch",
  "r4",
  "missing-risk-signals",
  "incomplete-risk-signals",
  "high-stakes",
  "missing-high-stakes",
  "unshipped-adapter",
  "rate-limit-exhausted",
  "cooldown-active",
  "missing-approval",
  "invalid-approval",
  "packet-tos-noncompliant",
  "non-synthetic-profile"
] as const;

const PROOF_SCENARIOS = [
  "valid-confirmation-page",
  "missing-positive-indicator",
  "negative-completion-signal",
  "untrusted-collector",
  "binding-mismatch",
  "invalid-signature",
  "tampered-receipt",
  "capture-before-window",
  "ats-missing-reference",
  "ats-valid-reference",
  "sent-items-complete",
  "sent-items-missing-attachment",
  "sent-items-missing-recipient",
  "sent-items-invalid-time",
  "source-domain-mismatch",
  "adapter-not-allowed",
  "kind-not-allowed"
] as const;

const CLAIM_TRACE_SCENARIOS = [
  "valid",
  "claim-inflation",
  "missing-claim",
  "unverified-claim",
  "private-claim",
  "disallowed-use",
  "stale-evidence",
  "profile-mismatch",
  "canonical-hash-mismatch",
  "injected-structural-text",
  "untraced-node"
] as const;

export type VocationBenchSafetyScenario = (typeof SAFETY_SCENARIOS)[number];
export type VocationBenchProofScenario = (typeof PROOF_SCENARIOS)[number];
export type VocationBenchClaimTraceScenario = (typeof CLAIM_TRACE_SCENARIOS)[number];

export interface VocationBenchLivenessObservationFixture {
  observedAt: string;
  availability: SourceAvailability;
  uncertainty: string[];
}

export interface VocationBenchLivenessCaseFixture {
  caseId: string;
  expectedState: LivenessState;
  observations: VocationBenchLivenessObservationFixture[];
}

export interface VocationBenchLivenessFixtureSuite {
  suiteVersion: "1.0.0";
  assessedAt: string;
  cases: VocationBenchLivenessCaseFixture[];
}

export interface VocationBenchDedupeCaseFixture {
  caseId: string;
  expectedOutcome: DedupeOutcome;
  left: DedupeCandidate;
  right: DedupeCandidate;
}

export interface VocationBenchDedupeFixtureSuite {
  suiteVersion: "1.0.0";
  cases: VocationBenchDedupeCaseFixture[];
}

export interface VocationBenchSafetyCaseFixture {
  caseId: string;
  scenario: VocationBenchSafetyScenario;
  expectedAllowed: boolean;
  expectedBlockedBy: string | null;
}

export interface VocationBenchProofCaseFixture {
  caseId: string;
  scenario: VocationBenchProofScenario;
  expectedStatus: "confirmed" | "insufficient" | "rejected";
}

export interface VocationBenchSafetyProofFixtureSuite {
  suiteVersion: "1.0.0";
  evaluatedAt: string;
  safetyCases: VocationBenchSafetyCaseFixture[];
  proofCases: VocationBenchProofCaseFixture[];
}

export interface VocationBenchClaimTraceCaseFixture {
  caseId: string;
  scenario: VocationBenchClaimTraceScenario;
  expectedValid: boolean;
}

export interface VocationBenchClaimTraceFixtureSuite {
  suiteVersion: "1.0.0";
  evaluatedAt: string;
  cases: VocationBenchClaimTraceCaseFixture[];
}

export interface VocationBenchCalibrationCaseFixture {
  caseId: string;
  predictedProbability: number;
  observedOutcome: 0 | 1;
}

export interface VocationBenchCalibrationFixtureSuite {
  suiteVersion: "1.0.0";
  bins: number;
  cases: VocationBenchCalibrationCaseFixture[];
}

export interface VocationBenchExecutableFixtures {
  liveness: VocationBenchLivenessFixtureSuite;
  dedupe: VocationBenchDedupeFixtureSuite;
  safetyProof: VocationBenchSafetyProofFixtureSuite;
  claimTrace: VocationBenchClaimTraceFixtureSuite;
  calibration: VocationBenchCalibrationFixtureSuite;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`${context} has unexpected or missing fields`);
  }
}

function assertString(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048 || value.includes("\0")) {
    throw new Error(`${context} must be a bounded non-empty string`);
  }
}

function assertNullableString(value: unknown, context: string): asserts value is string | null {
  if (value !== null) assertString(value, context);
}

function assertBoolean(value: unknown, context: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be boolean`);
}

function assertCanonicalTimestamp(value: unknown, context: string): asserts value is string {
  assertString(value, context);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${context} must be a canonical ISO date-time`);
  }
}

function assertStringArray(value: unknown, context: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  value.forEach((entry, index) => assertString(entry, `${context}[${index}]`));
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string
): asserts value is T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${context} is not an allowed value`);
  }
}

function assertCaseId(value: unknown, context: string): asserts value is string {
  assertString(value, context);
  if (!/^VB-[A-Z0-9-]{3,80}$/.test(value)) throw new Error(`${context} is invalid`);
}

function assertCaseCount(cases: unknown[], context: string): void {
  if (cases.length < 1) throw new Error(`${context} requires at least one case`);
  if (cases.length > MAX_VOCATION_BENCH_CASES_PER_SUITE) {
    throw new Error(`${context} exceeds the ${MAX_VOCATION_BENCH_CASES_PER_SUITE} case runtime bound`);
  }
}

function assertUniqueCaseIds(cases: unknown[], context: string): void {
  const ids = cases.map((entry, index) => {
    assertRecord(entry, `${context} case ${index}`);
    return entry["caseId"];
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${context} case ids must be unique`);
}

function assertSuiteVersion(value: Record<string, unknown>, context: string): void {
  if (value["suiteVersion"] !== "1.0.0") throw new Error(`${context} suiteVersion must be 1.0.0`);
}

function assertLivenessFixture(value: unknown): asserts value is VocationBenchLivenessFixtureSuite {
  assertRecord(value, "Liveness fixture");
  assertExactKeys(value, ["suiteVersion", "assessedAt", "cases"], "Liveness fixture");
  assertSuiteVersion(value, "Liveness fixture");
  assertCanonicalTimestamp(value["assessedAt"], "Liveness assessedAt");
  if (!Array.isArray(value["cases"])) throw new Error("Liveness cases must be an array");
  assertCaseCount(value["cases"], "Liveness fixture");
  const cases = value["cases"];
  cases.forEach((entry, caseIndex) => {
    assertRecord(entry, `Liveness case ${caseIndex}`);
    assertExactKeys(entry, ["caseId", "expectedState", "observations"], `Liveness case ${caseIndex}`);
    assertCaseId(entry["caseId"], `Liveness case ${caseIndex} caseId`);
    assertEnum(entry["expectedState"], ["live", "closed", "stale", "unreachable", "unresolved"], `Liveness case ${caseIndex} expectedState`);
    if (!Array.isArray(entry["observations"])) throw new Error(`Liveness case ${caseIndex} observations must be an array`);
    if (entry["observations"].length > 10) throw new Error(`Liveness case ${caseIndex} has too many observations`);
    entry["observations"].forEach((observation, observationIndex) => {
      assertRecord(observation, `Liveness case ${caseIndex} observation ${observationIndex}`);
      assertExactKeys(
        observation,
        ["observedAt", "availability", "uncertainty"],
        `Liveness case ${caseIndex} observation ${observationIndex}`
      );
      assertCanonicalTimestamp(observation["observedAt"], `Liveness case ${caseIndex} observedAt`);
      assertEnum(observation["availability"], SOURCE_AVAILABILITY_STATES, `Liveness case ${caseIndex} availability`);
      assertStringArray(observation["uncertainty"], `Liveness case ${caseIndex} uncertainty`);
    });
  });
  assertUniqueCaseIds(cases, "Liveness fixture");
}

function assertDedupeCandidate(value: unknown, context: string): asserts value is DedupeCandidate {
  assertRecord(value, context);
  const required = [
    "candidateId",
    "observationId",
    "providerId",
    "sourceRecordId",
    "canonicalUrl",
    "applyUrl",
    "company",
    "companyDomain",
    "roleTitle",
    "location",
    "postedAt",
    "descriptionDigest"
  ];
  assertExactKeys(value, [...required, "taxonomyConceptIds"].filter((key) => key !== "taxonomyConceptIds" || key in value), context);
  for (const key of ["candidateId", "observationId", "providerId", "sourceRecordId", "canonicalUrl", "company", "roleTitle", "location"]) {
    assertString(value[key], `${context}.${key}`);
  }
  for (const key of ["applyUrl", "companyDomain", "postedAt", "descriptionDigest"]) {
    assertNullableString(value[key], `${context}.${key}`);
  }
  if ("taxonomyConceptIds" in value) assertStringArray(value["taxonomyConceptIds"], `${context}.taxonomyConceptIds`);
}

function assertDedupeFixture(value: unknown): asserts value is VocationBenchDedupeFixtureSuite {
  assertRecord(value, "Dedupe fixture");
  assertExactKeys(value, ["suiteVersion", "cases"], "Dedupe fixture");
  assertSuiteVersion(value, "Dedupe fixture");
  if (!Array.isArray(value["cases"])) throw new Error("Dedupe cases must be an array");
  assertCaseCount(value["cases"], "Dedupe fixture");
  const cases = value["cases"];
  cases.forEach((entry, index) => {
    assertRecord(entry, `Dedupe case ${index}`);
    assertExactKeys(entry, ["caseId", "expectedOutcome", "left", "right"], `Dedupe case ${index}`);
    assertCaseId(entry["caseId"], `Dedupe case ${index} caseId`);
    assertEnum(entry["expectedOutcome"], ["merge", "review", "distinct"], `Dedupe case ${index} expectedOutcome`);
    assertDedupeCandidate(entry["left"], `Dedupe case ${index}.left`);
    assertDedupeCandidate(entry["right"], `Dedupe case ${index}.right`);
  });
  assertUniqueCaseIds(cases, "Dedupe fixture");
}

function assertSafetyProofFixture(value: unknown): asserts value is VocationBenchSafetyProofFixtureSuite {
  assertRecord(value, "Safety proof fixture");
  assertExactKeys(value, ["suiteVersion", "evaluatedAt", "safetyCases", "proofCases"], "Safety proof fixture");
  assertSuiteVersion(value, "Safety proof fixture");
  assertCanonicalTimestamp(value["evaluatedAt"], "Safety proof evaluatedAt");
  if (!Array.isArray(value["safetyCases"]) || !Array.isArray(value["proofCases"])) {
    throw new Error("Safety proof case sets must be arrays");
  }
  assertCaseCount(value["safetyCases"], "Safety fixture");
  assertCaseCount(value["proofCases"], "Proof fixture");
  if (value["safetyCases"].length + value["proofCases"].length > MAX_VOCATION_BENCH_CASES_PER_SUITE) {
    throw new Error("Safety proof fixture exceeds the combined runtime bound");
  }
  value["safetyCases"].forEach((entry, index) => {
    assertRecord(entry, `Safety case ${index}`);
    assertExactKeys(entry, ["caseId", "scenario", "expectedAllowed", "expectedBlockedBy"], `Safety case ${index}`);
    assertCaseId(entry["caseId"], `Safety case ${index} caseId`);
    assertEnum(entry["scenario"], SAFETY_SCENARIOS, `Safety case ${index} scenario`);
    assertBoolean(entry["expectedAllowed"], `Safety case ${index} expectedAllowed`);
    assertNullableString(entry["expectedBlockedBy"], `Safety case ${index} expectedBlockedBy`);
  });
  value["proofCases"].forEach((entry, index) => {
    assertRecord(entry, `Proof case ${index}`);
    assertExactKeys(entry, ["caseId", "scenario", "expectedStatus"], `Proof case ${index}`);
    assertCaseId(entry["caseId"], `Proof case ${index} caseId`);
    assertEnum(entry["scenario"], PROOF_SCENARIOS, `Proof case ${index} scenario`);
    assertEnum(entry["expectedStatus"], ["confirmed", "insufficient", "rejected"], `Proof case ${index} expectedStatus`);
  });
  const combined = [...value["safetyCases"], ...value["proofCases"]];
  assertUniqueCaseIds(combined, "Safety proof fixture");
}

function assertClaimTraceFixture(value: unknown): asserts value is VocationBenchClaimTraceFixtureSuite {
  assertRecord(value, "Claim trace fixture");
  assertExactKeys(value, ["suiteVersion", "evaluatedAt", "cases"], "Claim trace fixture");
  assertSuiteVersion(value, "Claim trace fixture");
  assertCanonicalTimestamp(value["evaluatedAt"], "Claim trace evaluatedAt");
  if (!Array.isArray(value["cases"])) throw new Error("Claim trace cases must be an array");
  assertCaseCount(value["cases"], "Claim trace fixture");
  const cases = value["cases"];
  cases.forEach((entry, index) => {
    assertRecord(entry, `Claim trace case ${index}`);
    assertExactKeys(entry, ["caseId", "scenario", "expectedValid"], `Claim trace case ${index}`);
    assertCaseId(entry["caseId"], `Claim trace case ${index} caseId`);
    assertEnum(entry["scenario"], CLAIM_TRACE_SCENARIOS, `Claim trace case ${index} scenario`);
    assertBoolean(entry["expectedValid"], `Claim trace case ${index} expectedValid`);
  });
  assertUniqueCaseIds(cases, "Claim trace fixture");
}

function assertCalibrationFixture(value: unknown): asserts value is VocationBenchCalibrationFixtureSuite {
  assertRecord(value, "Calibration fixture");
  assertExactKeys(value, ["suiteVersion", "bins", "cases"], "Calibration fixture");
  assertSuiteVersion(value, "Calibration fixture");
  if (!Number.isInteger(value["bins"]) || (value["bins"] as number) < 2 || (value["bins"] as number) > 100) {
    throw new Error("Calibration bins must be an integer between 2 and 100");
  }
  if (!Array.isArray(value["cases"])) throw new Error("Calibration cases must be an array");
  assertCaseCount(value["cases"], "Calibration fixture");
  const cases = value["cases"];
  cases.forEach((entry, index) => {
    assertRecord(entry, `Calibration case ${index}`);
    assertExactKeys(entry, ["caseId", "predictedProbability", "observedOutcome"], `Calibration case ${index}`);
    assertCaseId(entry["caseId"], `Calibration case ${index} caseId`);
    if (
      typeof entry["predictedProbability"] !== "number" ||
      !Number.isFinite(entry["predictedProbability"]) ||
      entry["predictedProbability"] < 0 ||
      entry["predictedProbability"] > 1
    ) {
      throw new Error(`Calibration case ${index} probability must be between 0 and 1`);
    }
    if (entry["observedOutcome"] !== 0 && entry["observedOutcome"] !== 1) {
      throw new Error(`Calibration case ${index} observedOutcome must be 0 or 1`);
    }
  });
  assertUniqueCaseIds(cases, "Calibration fixture");
}

export function assertVocationBenchFixtures(value: unknown): asserts value is VocationBenchExecutableFixtures {
  assertRecord(value, "VocationBench fixture bundle");
  assertExactKeys(
    value,
    ["liveness", "dedupe", "safetyProof", "claimTrace", "calibration"],
    "VocationBench fixture bundle"
  );
  assertLivenessFixture(value["liveness"]);
  assertDedupeFixture(value["dedupe"]);
  assertSafetyProofFixture(value["safetyProof"]);
  assertClaimTraceFixture(value["claimTrace"]);
  assertCalibrationFixture(value["calibration"]);
}

function readFixtureFile(directory: string, fileName: string): unknown {
  const filePath = path.resolve(directory, fileName);
  const size = statSync(filePath).size;
  if (size > MAX_FIXTURE_FILE_BYTES) {
    throw new Error(`${fileName} exceeds the ${MAX_FIXTURE_FILE_BYTES} byte fixture bound`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse VocationBench fixture ${fileName}: ${message}`);
  }
}

export function loadVocationBenchFixtures(directory: string): VocationBenchExecutableFixtures {
  if (!directory.trim()) throw new Error("VocationBench fixture directory is required");
  const liveness = readFixtureFile(directory, VOCATION_BENCH_FIXTURE_FILES.liveness);
  const dedupe = readFixtureFile(directory, VOCATION_BENCH_FIXTURE_FILES.dedupe);
  const safetyProof = readFixtureFile(directory, VOCATION_BENCH_FIXTURE_FILES.safetyProof);
  const claimTrace = readFixtureFile(directory, VOCATION_BENCH_FIXTURE_FILES.claimTrace);
  const calibration = readFixtureFile(directory, VOCATION_BENCH_FIXTURE_FILES.calibration);
  const fixtures = { liveness, dedupe, safetyProof, claimTrace, calibration };
  assertVocationBenchFixtures(fixtures);
  return fixtures;
}
