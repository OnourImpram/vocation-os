# VocationOS Implementation Checklist

- [x] Build clean public repo boundary.
- [x] Enforce privacy and brand scans.
- [x] Add strict TypeScript and schema validation.
- [x] Add claim graph, application packet, and action ledger.
- [x] Enforce high stakes, reversibility, and auto apply gates.
- [x] Add tests, CI, docs, and release packaging.
- [x] Add public release blocker upgrades for claim hash binding, packet hash validation, unique ledger ids, pack check, real state validation, risk signals, rate limit, and specialist questions.
- [x] Add VocationOS Decision Control Room Astro microsite, GitHub Pages workflow, and generated banner assets.

## Verification Notes

- 2026-07-04: `npm run safe:publish-check` passed.
- 2026-07-04: `npm pack --dry-run` produced a clean package surface with `dist/cli.js` and without `dist/src`, `dist/test`, `.vocationos`, or `node_modules`.
- 2026-07-04: direct old-name search returned zero matches outside dependencies.
- 2026-07-04: `node dist/cli.js doctor` passed from a temporary working directory.
- 2026-07-05: `npm run site:build` passed for the Astro microsite.
- 2026-07-05: Generated `assets/control-room-background.png`, `assets/vocationos-banner.png`, and `assets/social-preview.png`.

## 2026-07-05 Review Integration

- [x] Interpret shared post-public review as implementation input, not as a GitHub comment thread.
- [x] Add a public release validation note without copying the raw review text.
- [x] Link validation, safety, governance, changelog, and roadmap surfaces.
- [x] Verify privacy, brand, docs, test, package, and site gates.

## v0.3.1 Safety Foundation and v1 Platform Track

- [x] Reproduce and close every known auto-apply authorization bypass.
- [x] Make Approved Auto approval mandatory and bind it to signer, packet, opportunity, adapter, action, and expiry.
- [x] Require complete automation risk observations and authoritative ledger rate limits.
- [x] Enforce document existence, content hashes, and policy-based evidence recency.
- [x] Persist kill-switch state and keep rearm separate from enablement.
- [x] Replace caller-authored completion evidence with trusted collector receipts.
- [x] Integrate reviewed v0.3 theory, opportunity, advisory, and lifecycle modules.
- [x] Add Career Digital Twin, worker capability, document AST, portfolio, and outcome contracts.
- [x] Add an append-only, hash-chained local event store foundation with snapshots and authenticated chain head.
- [x] Add deterministic agent orchestration, capability enforcement, and generator/evaluator separation.
- [x] Add VocationBench synthetic fixture stubs, adversarial cases, and validated baseline metrics.
- [x] Update schemas, CLI, README, safety, threat model, roadmap, and release evidence.
- [x] Pass typecheck, unit, schema, evaluator, privacy, brand, site, and package gates.
- [x] Run an independent adversarial review and resolve every P0 or P1 finding.
- [x] Commit, push, and open a reviewable GitHub PR without merging automatically.

### Baseline Evidence

- 2026-07-11: clean checkout created from `origin/main` at `8bd543f`.
- 2026-07-11: existing dirty checkout was left unchanged.
- 2026-07-11: baseline typecheck, 45 tests, schemas, selfcheck, evaluator, privacy, brand, and docs checks passed.
- 2026-07-11: full release gate exceeded the initial 300 second wrapper, so component timings are tracked separately.
