# VocationBench

VocationBench is the deterministic internal evaluation surface for VocationOS. It executes current product policy code against committed synthetic fixtures. It does not use real candidate data.

## Executable Suites

The release fixture set under `benchmarks/vocation-bench` contains 94 bounded cases. Tests exercise the same content from `test/fixtures/vocation-bench` so package and mutation fixtures can be validated independently.

1. Liveness has 13 cases for current, stale, closed, unreachable, unresolved, future skew, and missing evidence states.
2. Dedupe has 12 pairwise cases for exact identity, normalized URLs, shared provenance, review states, provider record conflicts, domain conflicts, and material identity mismatches.
3. Safety has 21 cases. One positive control must pass every gate. Twenty adversarial cases exercise risk signals, high stakes flags, approvals, rate limits, cooldowns, reversibility, terms status, adapter authority, and synthetic profile scope.
4. Submission proof has 17 cases for confirmed, insufficient, and rejected outcomes. Cases include forged signatures, receipt tampering, binding mismatches, stale capture, untrusted collectors, missing ATS references, and incomplete Sent Items evidence.
5. Claim trace has 11 Document AST v2 cases. The suite tests claim inflation, missing claims, unverified or private claims, stale evidence, profile mismatch, hash mismatch, structural text injection, and untraced content.
6. Calibration has 20 labeled predictions across five bins.

The manifest generator remains separate. It publishes the broader synthetic scale of 500 profile stubs, 2,000 opportunity stubs, 300 adversarial stubs, 200 proof stubs, and 100 credential stubs.

## Execution

The compiled CLI executes the committed fixture set and emits the deterministic report:

```bash
vocation benchmark
```

The same runner is available as a TypeScript API:

```ts
import path from "node:path";
import { runVocationBenchFromDirectory } from "./src/benchmark/vocation-bench.js";

const report = runVocationBenchFromDirectory(
  path.resolve("benchmarks/vocation-bench")
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
```

Each fixture file is limited to 1 MB. Each suite is limited to 500 cases. The combined safety and proof suite shares the same 500 case cap.

## Report Contract

Every run returns:

1. A canonical SHA 256 hash for each fixture suite.
2. An aggregate fixture set hash.
3. A deterministic run ID derived from the benchmark version, fixture set hash, thresholds, and suite outputs.
4. Per case expected and actual classifications.
5. Per suite metrics and explicit threshold verdicts.
6. A scoped overall `PASS` or `FAIL` for executed internal thresholds only.
7. Explicit baseline execution status and deferred comparative thresholds.

No wall clock timestamp is included in the executable result. Identical fixtures and thresholds produce the same report and run ID.

## Release Thresholds

1. Claim trace coverage must equal 1.00.
2. False allow rate must equal 0.
3. False confirmation rate must equal 0.
4. Dedupe F1 must be at least 0.97.
5. Liveness precision must be at least 0.98.
6. Calibration expected calibration error must be no greater than 0.08.
7. Calibration requires at least 20 labeled outcomes.
8. Fixture classification conformance must equal 1.00 for liveness state, dedupe outcome, safety, proof, and claim trace cases.

NDCG at k, Brier score, expected calibration error, classification F1, false allow rate, and false confirmation rate remain available as metric primitives.

## Comparison Boundary

An internal VocationBench pass does not imply competitor superiority.

Open source baselines remain `not-run` until reproducible local execution evidence is supplied. Proprietary baselines remain `not-run` until permitted documented manual run evidence is supplied. Scraped, reverse engineered, inferred, or invented scores are prohibited.

The minimum ranking improvement threshold of 0.10 remains `not-evaluated` while baseline evidence is absent. The safety core mutation score threshold of 0.85 also remains `not-evaluated` because this bounded runner does not execute a mutation testing engine. Neither deferred threshold blocks the scoped internal verdict. The report always records competitor superiority as `not-assessed`.
