# VocationOS Implementation Checklist

## v0.6.0 Market Leadership Mega Release

- [x] Freeze public contracts and create the release workspace boundaries.
- [x] Add the governed network boundary and provider SDK.
- [x] Ship 36 contract-tested discovery providers and a 250-entry portal catalog.
- [x] Add source observations, opportunity truth, liveness, dedupe, and taxonomy normalization.
- [x] Upgrade the Career Digital Twin, portfolio intelligence, campaigns, documents, and tracker.
- [x] Ship the daemon-backed TUI, workbench, agent skill, MCP, and model gateway surfaces.
- [x] Add Career Assurance Case, Credential Passport, Interview, Network, Offer, and outcome learning systems.
- [x] Expand VocationBench and pass safety, benchmark, coverage, packaging, privacy, and release gates.
- [x] Complete an independent adversarial review with no open P0 or P1 finding.
- [x] Publish one reviewable pull request without npm publication.

### v0.6.0 Baseline Evidence

- 2026-07-14: clean worktree created from `origin/main` at `d15f660a1b02a7e01e20dc817e8346cd3eee7c17`.
- 2026-07-14: existing dirty product checkout was left unchanged.
- 2026-07-14: `npm ci` completed with zero reported vulnerabilities.
- 2026-07-14: baseline `npm run safe:publish-check` passed with 55 test files, 298 tests, 30 schemas, 19 evaluator cases, 23 citation records, a 458 component SBOM, 2 Astro pages, external CLI smoke, and production tarball install verification.
- 2026-07-16: 36 provider contracts, 278 identity-confirmed portal routes, 209 separately retained unresolved routes, 53 schemas, and 73 CLI commands are present in the release tree.
- 2026-07-16: focused authority, SDK, TUI, workbench, installer, model gateway, assurance, credential, discovery, taxonomy, and product command tests passed before the full release gate.
- 2026-07-16: dedupe review projection now aggregates every relation in the latest result and conservatively preserves `review` over `merge` or `distinct`.
- 2026-07-17: real `eddsa-rdfc-2022` verification passed for controlled HTTPS issuer documents and the offline `did:key` daemon resolver. Altered content, unauthorized controllers, unresolved issuers, and multiple proofs fail closed.
- 2026-07-17: final local `npm run safe:publish-check` passed with 103 test files, 679 tests, 53 schemas, 19 evaluator cases, 23 citation records, a 530 component SBOM, 2 Astro pages, external CLI smoke, and a clean production tarball install.
- 2026-07-17: combined coverage passed at 80.95 percent statements, 71.63 percent branches, 91.82 percent functions, and 85.24 percent lines.
- 2026-07-17: independent read-only review inspected the complete diff and reported no open P0 or P1 finding. Its sandbox could not execute Node or npm, so the static verdict supplements the complete local release gate.
- 2026-07-17: pull request `#14` published the hash-verified release branch for protected-branch review. No npm publication was performed.
- 2026-07-17: the first protected-branch run caught clean workspace dependency ordering, two path check then read boundaries, repetition-sensitive route normalization, and Rust formatting drift. The remediations passed focused tests, clean SDK build reproduction, and the complete local release gate.

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

## v0.4 Encrypted Runtime and Authority

- [x] Replace implicit schema creation with checksummed, versioned SQLite migrations.
- [x] Add idempotent dry-run and execute paths for legacy state, config, and ledger import.
- [x] Add encrypted, authenticated database backup and crash-safe restore with explicit overwrite approval.
- [x] Add strict credential-provider boundaries for OS keyring and headless passphrase operation.
- [x] Add `vocationd` as the single-writer local authority with authenticated IPC and request idempotency.
- [x] Route consequential config mutations through the authority while retaining documented compatibility behavior.
- [x] Add Ed25519-signed event-chain checkpoints and an exportable audit bundle.
- [x] Add migration, import, backup, restore, daemon, IPC, checkpoint, and rollback adversarial tests.
- [x] Update CLI contracts, schemas, threat model, roadmap, changelog, and release evidence.
- [x] Pass the full release gate and independent P0/P1 review.
- [x] Publish a reviewable `release/v0.4` branch and PR without automatic merge.

### v0.4 Baseline Evidence

- 2026-07-11: fresh checkout created from merged `origin/main` at `bcf30d67b4b9b96a2bc067ada543f679075a55e6`.
- 2026-07-11: `npm ci` completed with zero reported vulnerabilities.
- 2026-07-11: baseline `npm run safe:publish-check` passed with 157 tests, 17 schemas, and 19 evaluator cases.
- 2026-07-11: local git ref creation was denied by the runtime policy. The validated tree will be published through the GitHub Git Data API.
- 2026-07-11: resumed after archived-task recovery from the v0.4 CLI authority handoff point.
- 2026-07-11: `npm run typecheck` passed after daemon, IPC, credential, checkpoint, migration, import, and backup additions.
- 2026-07-11: `npm test` passed with 34 test files and 185 tests, including daemon authority, IPC, single-instance, checkpoint, encrypted backup, and legacy import coverage.
- 2026-07-11: `npm run build`, `npm run validate:schemas`, `npm run selfcheck`, and `npm run evaluate` passed.
- 2026-07-11: `node dist\cli.js daemon-status` failed closed when `vocationd` credentials were not initialized, as expected.
- 2026-07-11: Initial bounded architecture reviews identified preauthentication migration, split authority, idempotency, rollback, key custody, and external checkpoint risks. Final bounded P0/P1 review found no P0 issue. Valid release truth and docs metric blockers were fixed.
- 2026-07-11: `npm test -- test/unit/action-ledger.test.ts` passed after the rate limit fixture was aligned with signed approver verification and submitted ledger usage.
- 2026-07-11: `npm test -- test/unit/runtime-policy-authority.test.ts` passed with 6 tests for canonical config, approver registry, ledger path, document root, adapter allowlist, and idempotent authority behavior.
- 2026-07-11: a focused remediation pass closed early-lock ordering, interrupted restore recovery, mandatory checkpoint verification, physical schema drift detection, chain-bound import backups, and headless credential rollback findings.
- 2026-07-11: final `npm run ci` passed with 41 test files, 218 tests, 20 schemas, 19 evaluator cases, 23 citation records, a 411-component SBOM, 2 Astro pages, and a clean package surface.
- 2026-07-11: a fresh independent read only P0/P1 review returned PASS with no remaining blocker.
- 2026-07-11: real Windows binary smoke reached healthy daemon state, applied 2 migrations, accepted authenticated CLI requests, and persisted `killSwitch.engaged=true`, `enabled=false`, and `mode=manual` before cleanup.
- 2026-07-11: a second fresh read only review found two release blocking P1 boundaries involving a missing daemon lock record and malformed evaluation data reaching the event store. Publication was stopped and the final gate was reopened.
- 2026-07-11: both final P1 remediations passed focused tests, the complete release gate, and independent focused rechecks with no remaining P0 or P1 issue.
- 2026-07-11: adversarial Windows binary smoke removed the live daemon lock, verified that a second daemon failed closed on the reachable endpoint, and confirmed that the first daemon retained authenticated authority.
- 2026-07-11: GitHub Git Data API published 56 verified file blobs in commit `7146316efeeb49a8886025651ba742e43ab3e2ba` on `release/v0.4`. The remote recursive tree matched every local canonical blob hash.
- 2026-07-11: pull request `#5` opened without automatic merge or npm publication. GitHub Actions run `29157345842` passed on Ubuntu in 46 seconds and Windows in 1 minute 37 seconds.

## Product Maturity Program

### Phase 0, v0.4.1 Product Engineering Baseline

- [x] Start from a fresh `origin/main` checkout and preserve previous dirty worktrees.
- [x] Remove GitHub Actions runtime deprecation warnings.
- [x] Add npm workspace boundaries without changing the `vocation` or `vocationd` contracts.
- [x] Add durable coverage, CLI subprocess, migration, packaging, and cross-platform release gates.
- [x] Publish a reviewed v0.4.1 maintenance pull request without npm publication.

### Phase 1, v0.5 Product Foundation

- [x] Add domain repositories for profiles, opportunities, documents, campaigns, applications, tasks, outcomes, and answers behind `vocationd`.
- [x] Add a content-addressed encrypted artifact vault for CV, PDF, DOCX, and generated artifacts.
- [x] Add resumable and idempotent `vocation init` onboarding with demo, profile, and resume modes. Headless uses an explicitly started headless daemon.
- [x] Add safe PDF, DOCX, Markdown, and UTF-8 import planning with exact plan hash approval binding.
- [x] Add Document AST v2, claim-bound rendering, PDF and DOCX output, parse-back verification, and answer memory.
- [x] Add an event-sourced application tracker and end-to-end synthetic user journey.

### Phase 2, v0.6 Discovery and Company Catalog

- [x] Add a centrally governed fetch broker and typed provider SDK.
- [x] Ship 36 contract-tested discovery adapters and keep unsupported dynamic routes outside execution authority.
- [x] Add a versioned catalog with at least 250 identity-confirmed company entries and domain-specific source packs.
- [x] Add provider health, liveness, pagination, retry, cache, provenance, dedupe, and campaign controls.

### Phase 3, v0.7 Product Workbench

- [x] Add a TypeScript TUI backed only by the typed daemon SDK.
- [x] Add a secure loopback web gateway and React workbench.
- [x] Add Today, Discovery, Opportunity Review, Documents, Pipeline, Evidence, Approvals, Audit, Provider Health, and Settings views.
- [ ] Pass independent WCAG 2.2 AA, signed cross-platform native artifact, recovery, and state parity gates.

### Phase 4, v0.8 Agent Ecosystem

- [x] Add a read-first local MCP server and canonical Open Agent Skill.
- [x] Add install, update, doctor, and uninstall flows for Codex, Claude Code, OpenCode, Gemini or Antigravity, Qwen Code, Kimi CLI, Grok Build, and GitHub Copilot CLI.
- [x] Separate discovered, invocable, and verified support levels with conformance tests.
- [x] Keep every mutating agent operation behind daemon capability and scoped approval.

### Phase 5, v0.9 to v1.0 Stable Product

- [ ] Add Interview Studio, Network Intelligence, Offer Lab, outcome learning, English and Turkish parity, and portable encrypted vault migration.
- [ ] Publish VocationBench baseline results and meet all safety, discovery, document, UI, and calibration targets.
- [ ] Ship signed Windows, macOS, and Linux releases with stable migrations, recovery drills, SBOM, provenance, and no unresolved P0 or P1 findings.

### Product Program Evidence

- 2026-07-11: fresh product checkout created from merged `origin/main` at `17e94a74bd80d85ae4404bfd7711398ec6f89f55`.
- 2026-07-11: `npm ci` completed with zero reported vulnerabilities. The existing native addon emitted a non-blocking `prebuild-install` deprecation warning.
- 2026-07-11: the first local typecheck exceeded the 120 second command wrapper. Remote `main` CI remained green, and the local typecheck must be rerun with a wider bound before edits are accepted.
- 2026-07-11: strict TypeScript passed with the SDK workspace built before the root project.
- 2026-07-11: focused SDK, onboarding, and encrypted artifact tests passed with 21 tests.
- 2026-07-11: compiled `vocation help` and `vocation doctor` passed from an external temporary working directory.
- 2026-07-12: isolated maintenance clone passed 42 test files and 220 tests with 82.57 percent statement, 70.80 percent branch, 92.44 percent function, and 85.11 percent line coverage.
- 2026-07-12: isolated maintenance clone passed schemas, selfcheck, evaluator, privacy, brand, citation, SBOM, site, subprocess, and package gates without npm publication.
- 2026-07-12: real Windows `vocation init --demo` smoke created a complete version 8 onboarding session plus one profile and one opportunity, then cleaned its daemon, runtime, and OS credentials.
- 2026-07-12: real Windows `vocation init --profile` parsed a local UTF-8 profile, stopped at claim review, and applied two analysis-only facts only after exact plan hash approval.
- 2026-07-12: generated PDF and DOCX fixtures plus multilingual renderer output passed isolated parse-back verification.
- 2026-07-12: the golden product journey persisted 16 valid events across onboarding, discovery, document, tracker, task, answer, and outcome surfaces.
- 2026-07-12: independent adversarial review reopened the release gate for stale onboarding receipts and parser spawn failure settlement. Controlled concurrency and child lifecycle tests now cover both boundaries.
- 2026-07-12: a second adversarial pass exposed non-linearizable concurrent start and resume flows plus late parser success after timeout. Unique mutation identities, canonical post-mutation reads, prompt timeout rejection, and preserved `SIGKILL` escalation closed those races.
- 2026-07-12: final local `npm run safe:publish-check` passed 55 test files and 284 tests with 81.09 percent statement, 69.64 percent branch, 91.59 percent function, and 84.27 percent line coverage.
- 2026-07-12: 30 schemas, 19 evaluator cases, 23 citation records, a 462 component SBOM, 2 Astro pages, external CLI smoke, and a real production-only tarball install with PDF and DOCX parser smokes passed.
- 2026-07-12: authenticated Windows daemon shutdown returned `shutdown-authorized`, released the endpoint and lock, and left no running test process or test credential.
- 2026-07-12: the final onboarding race review found same-step version churn and a profile result envelope that could contradict terminal canonical state. Bounded canonical retry and canonical `nextAction` derivation now cover both cases.
- 2026-07-12: final independent read only re-review returned PASS with no P0 or P1 finding. Controlled probes confirmed bounded retry, canonical terminal results, one-time parser settlement, forced termination, sanitized diagnostics, and zero remaining child handles.

## Final Public Release Audit, 2026-07-12

- [x] Freeze and compare `main`, PR 6, and PR 7 commit and blob identities.
- [x] Re-run the complete release gate from a fresh production-like checkout.
- [x] Review runtime authority, encrypted storage, parser containment, document claims, application lifecycle, and onboarding concurrency for P0 and P1 defects.
- [x] Review package metadata, license detection, dependency health, workflows, Pages, release evidence, and repository security settings.
- [x] Apply only release-blocking or low-risk release-hardening corrections and add regression evidence.
- [ ] Obtain an independent adversarial verdict with no unresolved P0 or P1 finding.
- [ ] Merge the stacked release chain in order, rebase the second pull request onto `main`, and require green Ubuntu and Windows checks.
- [ ] Verify post-merge `main`, GitHub Pages, package archive, release evidence, and remote blob identity.
- [ ] Publish the GitHub `v0.5.0` release without publishing to npm.
- [ ] Enable appropriate main-branch and dependency security controls after merge.
- [ ] Record the next differentiated product package without expanding the v0.5 release scope.

### Reopened P1 Runtime Gates

- [x] Bind legacy import receipts to the authenticated event and reject forged receipt-only replay.
- [x] Bind tracker approvals to one attempt, recheck expiry and signer revocation at submit time, and reject approval reuse.
- [x] Bound IPC frame queues and pending handshakes without letting idle pre-auth sockets consume authenticated capacity.
- [x] Persist immutable onboarding mode and active profile plan hash, reject mode switching, and expose authenticated plan recovery.
- [x] Match answer memory by prompt identity and enforce sensitive and restricted reuse policy.
- [x] Replace profile candidate truncation with lossless segmentation and fail closed at the candidate ceiling.
- [x] Add operation-specific IPC deadlines and canonical retry guidance for long-running profile parsing.
- [x] Re-run focused exploit regressions before the complete release gate.

### Final Local Release Evidence, 2026-07-14

- [x] `npm run safe:publish-check` passed with 55 test files and 297 tests.
- [x] Coverage thresholds passed: 80 statements, 68 branches, 85 functions, and 80 lines.
- [x] Workflow pinning check passed for 4 GitHub workflow files.
- [x] JSON Schema validation passed for 30 schemas.
- [x] Evaluator passed 19 of 19 cases.
- [x] Citation contract passed for 23 offline records.
- [x] SBOM generation and parse passed.
- [x] Astro built 2 pages.
- [x] Real package tarball, production-only install, external CLI, and bounded PDF/DOCX parser smokes passed.
