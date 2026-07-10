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

## 2026-07-10 v0.3 Decision Intelligence Upgrade

### Discovery and architecture

- [x] Review the user supplied v0.3 upgrade plan, patch, theory map, and verification claims.
- [x] Reproduce strict typecheck and all 72 tests from the supplied patch in an isolated worktree.
- [x] Review current official Greenhouse, Lever, and Ashby public job posting contracts.
- [x] Review NIST AI RMF, OWASP agent security, Schema.org remote eligibility, and software provenance guidance.
- [x] Write the independent v0.3 implementation plan with accepted design choices, gaps, threat boundaries, and release gates.

### Core implementation

- [x] Add deterministic opportunity provenance and adapters for Greenhouse, Lever, Ashby, and manual input.
- [x] Add remote eligibility, freshness, apply route, description quality, and duplicate intake gates.
- [x] Add submission proof validation and an application lifecycle that cannot reach confirmed without sufficient evidence.
- [x] Harden the remote advisory client with endpoint policy, timeout, response size, content type, and redirect controls.
- [x] Add schema coverage for opportunity records, intake decisions, submission proofs, and application attempts.
- [x] Add CLI demos and evaluator cases for the new operational gates.

### Security, documentation, and release

- [x] Add a concrete threat model for ATS input, prompt injection, remote model egress, proof forgery, and ledger integrity.
- [x] Add offline unit, schema, golden, and adversarial tests for the new core.
- [x] Add SBOM validation and release provenance guidance without making offline CI network dependent.
- [x] Update README, roadmap, changelog, metrics, and package version for v0.3.0.
- [x] Run citation resolution, full CI, package smoke test, privacy scan, dependency audit, and adversarial verification.
- [x] Complete review notes with evidence, residual risks, and release handoff.

### Review notes

- 2026-07-10: `npm run safe:publish-check` passed. The gate included privacy, brand, strict TypeScript, all tests, schema validation, selfcheck, evaluator, documentation, SBOM, site build, and package smoke checks.
- 2026-07-10: 18 test files and 105 tests passed. The evaluator passed 18 of 18 scenarios.
- 2026-07-10: `npm run citations:check` resolved 23 of 23 DOI records through Crossref.
- 2026-07-10: `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities.
- 2026-07-10: The CycloneDX SBOM gate validated 360 components. `git diff --check` passed apart from informational Windows line ending warnings.
- 2026-07-10: Adversarial review added bounded proof pointers, preserved semantically meaningful URL parameters, validated approval references, and schema validated confirmation ledger entries.
- 2026-07-10: Independent reviewer execution did not complete because one route lacked an external model key and another timed out during tool startup. No external review claim is made. Independent review remains a merge gate.
