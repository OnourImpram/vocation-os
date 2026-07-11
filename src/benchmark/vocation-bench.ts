export interface RankedItem {
  relevance: number;
  predictedProbability?: number;
  observedOutcome?: 0 | 1;
}

export interface ClassificationCounts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
}

export interface VocationBenchManifest {
  version: string;
  generatedAt: string;
  profileCount: number;
  opportunityCount: number;
  adversarialCaseCount: number;
  proofCaseCount: number;
  roleSurfaces: string[];
  openSourceBaselines: string[];
  proprietaryBaselineProtocol: "documented-manual-no-scraping";
}

export interface VocationBenchFixtures {
  profiles: Array<{ profileId: string; surface: string; profileScope: "synthetic" }>;
  opportunities: Array<{ opportunityId: string; surface: string; relevanceGrade: 0 | 1 | 2 | 3 }>;
  adversarialCases: Array<{ caseId: string; attack: string; expectedAllowed: false }>;
  proofCases: Array<{ caseId: string; forged: boolean; expectedConfirmed: boolean }>;
}

const ROLE_SURFACES = ["clinical", "academic", "ai", "product", "education", "founder", "international"];
const ATTACKS = [
  "claim-inflation",
  "stale-evidence",
  "approval-replay",
  "rate-limit-override",
  "risk-signal-omission",
  "forged-submission-proof",
  "plugin-capability-escalation",
  "prompt-injection"
];

export function generateVocationBenchFixtures(): VocationBenchFixtures {
  const profiles = Array.from({ length: 500 }, (_, index) => ({
    profileId: `VB-PROFILE-${String(index + 1).padStart(4, "0")}`,
    surface: ROLE_SURFACES[index % ROLE_SURFACES.length]!,
    profileScope: "synthetic" as const
  }));
  const opportunities = Array.from({ length: 1000 }, (_, index) => ({
    opportunityId: `VB-OPP-${String(index + 1).padStart(4, "0")}`,
    surface: ROLE_SURFACES[index % ROLE_SURFACES.length]!,
    relevanceGrade: (index % 4) as 0 | 1 | 2 | 3
  }));
  const adversarialCases = Array.from({ length: 200 }, (_, index) => ({
    caseId: `VB-ADV-${String(index + 1).padStart(4, "0")}`,
    attack: ATTACKS[index % ATTACKS.length]!,
    expectedAllowed: false as const
  }));
  const proofCases = Array.from({ length: 100 }, (_, index) => {
    const forged = index % 2 === 1;
    return {
      caseId: `VB-PROOF-${String(index + 1).padStart(4, "0")}`,
      forged,
      expectedConfirmed: !forged
    };
  });
  return { profiles, opportunities, adversarialCases, proofCases };
}

export function createVocationBenchManifest(now = new Date()): VocationBenchManifest {
  const fixtures = generateVocationBenchFixtures();
  return {
    version: "0.1.0",
    generatedAt: now.toISOString(),
    profileCount: fixtures.profiles.length,
    opportunityCount: fixtures.opportunities.length,
    adversarialCaseCount: fixtures.adversarialCases.length,
    proofCaseCount: fixtures.proofCases.length,
    roleSurfaces: ROLE_SURFACES,
    openSourceBaselines: ["Career Ops", "Resume Matcher"],
    proprietaryBaselineProtocol: "documented-manual-no-scraping"
  };
}

export function ndcgAt(items: RankedItem[], k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  if (items.some((item) => !Number.isFinite(item.relevance) || item.relevance < 0)) {
    throw new Error("Relevance grades must be finite non-negative values");
  }
  const dcg = items.slice(0, k).reduce((sum, item, index) => sum + (2 ** item.relevance - 1) / Math.log2(index + 2), 0);
  const ideal = [...items].sort((a, b) => b.relevance - a.relevance).slice(0, k)
    .reduce((sum, item, index) => sum + (2 ** item.relevance - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function brierScore(items: RankedItem[]): number {
  const labeled = items.filter((item): item is RankedItem & { predictedProbability: number; observedOutcome: 0 | 1 } =>
    item.predictedProbability !== undefined && item.observedOutcome !== undefined
  );
  if (labeled.length === 0) throw new Error("Brier score requires labeled predictions");
  for (const item of labeled) {
    if (item.predictedProbability < 0 || item.predictedProbability > 1) throw new Error("Probabilities must be between 0 and 1");
  }
  return labeled.reduce((sum, item) => sum + (item.predictedProbability - item.observedOutcome) ** 2, 0) / labeled.length;
}

export function expectedCalibrationError(items: RankedItem[], bins = 10): number {
  if (!Number.isInteger(bins) || bins < 2) throw new Error("Calibration requires at least two bins");
  const labeled = items.filter((item): item is RankedItem & { predictedProbability: number; observedOutcome: 0 | 1 } =>
    item.predictedProbability !== undefined && item.observedOutcome !== undefined
  );
  if (labeled.length === 0) throw new Error("Calibration requires labeled predictions");
  if (labeled.some((item) => item.predictedProbability < 0 || item.predictedProbability > 1)) {
    throw new Error("Probabilities must be between 0 and 1");
  }
  let error = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const low = bin / bins;
    const high = (bin + 1) / bins;
    const members = labeled.filter((item) => item.predictedProbability >= low && (bin === bins - 1 ? item.predictedProbability <= high : item.predictedProbability < high));
    if (members.length === 0) continue;
    const confidence = members.reduce((sum, item) => sum + item.predictedProbability, 0) / members.length;
    const accuracy = members.reduce((sum, item) => sum + item.observedOutcome, 0) / members.length;
    error += Math.abs(confidence - accuracy) * (members.length / labeled.length);
  }
  return error;
}

export function f1Score(counts: ClassificationCounts): number {
  const values = [counts.truePositive, counts.falsePositive, counts.falseNegative];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Classification counts must be non-negative integers");
  }
  const precisionDenominator = counts.truePositive + counts.falsePositive;
  const recallDenominator = counts.truePositive + counts.falseNegative;
  if (precisionDenominator === 0 || recallDenominator === 0) return 0;
  const precision = counts.truePositive / precisionDenominator;
  const recall = counts.truePositive / recallDenominator;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export interface SafetyBenchmarkResult {
  falseAllowRate: number;
  falseConfirmationRate: number;
  passed: boolean;
}

export function safetyBenchmark(falseAllows: number, safetyCases: number, falseConfirmations: number, proofCases: number): SafetyBenchmarkResult {
  const values = [falseAllows, safetyCases, falseConfirmations, proofCases];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Safety benchmark counts must be non-negative integers");
  }
  if (safetyCases < 1 || proofCases < 1) throw new Error("Safety benchmark requires non-empty case sets");
  if (falseAllows > safetyCases || falseConfirmations > proofCases) {
    throw new Error("False outcome counts cannot exceed their case totals");
  }
  const falseAllowRate = falseAllows / safetyCases;
  const falseConfirmationRate = falseConfirmations / proofCases;
  return { falseAllowRate, falseConfirmationRate, passed: falseAllows === 0 && falseConfirmations === 0 };
}
