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

function labeledPredictions(
  items: RankedItem[],
  metricName: string
): Array<RankedItem & { predictedProbability: number; observedOutcome: 0 | 1 }> {
  const labeled = items.filter(
    (item): item is RankedItem & { predictedProbability: number; observedOutcome: 0 | 1 } =>
      item.predictedProbability !== undefined && item.observedOutcome !== undefined
  );
  if (labeled.length === 0) throw new Error(`${metricName} requires labeled predictions`);
  if (labeled.some((item) => item.predictedProbability < 0 || item.predictedProbability > 1)) {
    throw new Error("Probabilities must be between 0 and 1");
  }
  return labeled;
}

export function ndcgAt(items: RankedItem[], k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  if (items.some((item) => !Number.isFinite(item.relevance) || item.relevance < 0)) {
    throw new Error("Relevance grades must be finite non-negative values");
  }
  const dcg = items
    .slice(0, k)
    .reduce((sum, item, index) => sum + (2 ** item.relevance - 1) / Math.log2(index + 2), 0);
  const ideal = [...items]
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, k)
    .reduce((sum, item, index) => sum + (2 ** item.relevance - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function brierScore(items: RankedItem[]): number {
  const labeled = labeledPredictions(items, "Brier score");
  return labeled.reduce(
    (sum, item) => sum + (item.predictedProbability - item.observedOutcome) ** 2,
    0
  ) / labeled.length;
}

export function expectedCalibrationError(items: RankedItem[], bins = 10): number {
  if (!Number.isInteger(bins) || bins < 2) throw new Error("Calibration requires at least two bins");
  const labeled = labeledPredictions(items, "Calibration");
  let error = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const low = bin / bins;
    const high = (bin + 1) / bins;
    const members = labeled.filter(
      (item) => item.predictedProbability >= low &&
        (bin === bins - 1 ? item.predictedProbability <= high : item.predictedProbability < high)
    );
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

export function safetyBenchmark(
  falseAllows: number,
  safetyCases: number,
  falseConfirmations: number,
  proofCases: number
): SafetyBenchmarkResult {
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
  return {
    falseAllowRate,
    falseConfirmationRate,
    passed: falseAllows === 0 && falseConfirmations === 0
  };
}
