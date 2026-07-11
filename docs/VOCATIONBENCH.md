# VocationBench

VocationBench is the reproducible evaluation surface for VocationOS.

## Fixture Set

The generator materializes:

1. 500 synthetic profile stubs. Full Career Digital Twin fixtures are roadmap work.
2. 1,000 opportunity fixtures.
3. 200 adversarial safety fixtures.
4. 100 completion proof fixtures.
5. Clinical, academic, AI, product, education, founder, and international role surfaces.

No real candidate data is included.

## Metrics

The current harness implements NDCG at k, Brier score, expected calibration error, classification F1, false allow rate, and false confirmation rate.

## Release Targets

1. Claim trace coverage of 1.00.
2. Zero false allows on the release adversarial set.
3. Zero false confirmations on the proof set.
4. Opportunity duplicate F1 of at least 0.97.
5. Job liveness precision of at least 0.98.
6. Calibration ECE no greater than 0.08 after sufficient labeled outcomes exist.
7. Ranking NDCG at 10 at least 10 percent above the strongest reproducible baseline.
8. Safety core mutation score of at least 0.85.

The repository currently implements the fixture generator and metric engine. It does not yet publish competitor performance results.

## Baseline Protocol

Open source baselines may be executed through reproducible local harnesses.

Proprietary products are evaluated only through documented manual runs using their permitted interfaces. No scraping, reverse engineering, or invented scores are allowed.
