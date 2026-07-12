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

- [ ] Add a centrally governed fetch broker and typed provider SDK.
- [ ] Ship 24 GA discovery connectors and keep dynamic high-maintenance connectors assist-only until contract gates pass.
- [ ] Add a versioned catalog with at least 150 verified company entries and domain-specific source packs.
- [ ] Add provider health, liveness, pagination, retry, cache, provenance, dedupe, and campaign controls.

### Phase 3, v0.7 Product Workbench

- [ ] Add a TypeScript TUI backed only by the typed daemon SDK.
- [ ] Add a secure loopback web gateway and production React workbench.
- [ ] Add Today, Discovery, Opportunity Review, Documents, Pipeline, Evidence, Approvals, Audit, Provider Health, and Settings views.
- [ ] Pass keyboard, WCAG 2.2 AA, responsive, recovery, and state parity gates.

### Phase 4, v0.8 Agent Ecosystem

- [ ] Add a read-first local MCP server and canonical Open Agent Skill.
- [ ] Add install, update, doctor, and uninstall flows for Codex, Claude Code, OpenCode, Gemini or Antigravity, Qwen Code, Kimi CLI, Grok Build, and GitHub Copilot CLI.
- [ ] Separate discovered, invocable, and verified support levels with conformance tests.
- [ ] Keep every mutating agent operation behind daemon capability and scoped approval.

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
