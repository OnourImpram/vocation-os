# Release Validation

## v0.6.1 Security Patch Evidence

Date: 2026-07-17

Base: clean `origin/main` checkout at `5196c15091f5e1c6b375a4d0cfc15f176bebaaf1`.

The post-merge CodeQL analysis for `v0.6.0` identified a high-severity file-system race in artifact export recovery. Existing targets were checked with `lstat` and then read through the path again. Version `0.6.1` opens the target once, verifies regular-file and path identity against the descriptor, reads through that descriptor, rechecks descriptor metadata and path binding, and rejects symlink, replacement, size, metadata, or content drift.

| Check | Result |
| --- | --- |
| Focused authority regression | 6 of 6 passed, including valid descriptor-bound existing-target recovery |
| Agent bundle integrity | 7 of 7 workspace contract tests passed with a regenerated skill checksum |
| MCP subprocess lifecycle | 3 of 3 isolated stdio smoke tests passed |
| Privacy, brand, workflow, network, catalog | PASS |
| Strict TypeScript and workspace builds | PASS |
| Combined Vitest | 103 files, 680 tests passed |
| Coverage | 80.95 statements, 71.67 branches, 91.86 functions, 85.24 lines |
| JSON Schema | 53 schemas valid |
| Evaluator | 19 of 19 passed |
| Citation contract | 23 offline records passed |
| SBOM | 530 CycloneDX components parsed |
| Astro | 2 pages built |
| Package | Real tarball scan, production-only install, bundled SDK, external CLI, and bounded PDF and DOCX parser smokes passed |
| Dependency audit | Zero npm vulnerabilities reported |

The complete `npm run safe:publish-check` passed in an authorized local run because `selfcheck` intentionally writes and removes a probe under the user's local VocationOS state boundary. Remote CodeQL, Ubuntu, Windows, native Rust, dependency review, and protected-branch checks remain mandatory before merge. The GitHub release remains source first and does not publish to npm.

## v0.6.0 Decision Intelligence Evidence

Date: 2026-07-17

Base: clean `origin/main` worktree at `d15f660a1b02a7e01e20dc817e8346cd3eee7c17`. The existing dirty checkout was not modified.

Version 0.6.0 adds governed discovery, 36 provider contracts, a 278-route identity-confirmed portal catalog, opportunity truth, liveness, conservative dedupe, ESCO and O*NET normalization, Career Digital Twin and portfolio intelligence, campaign operations, TUI and workbench review surfaces, Career Assurance Case, Credential Passport, agent integrations, MCP, model egress policy, and VocationBench. It does not enable a production ATS execution adapter or npm publication.

| Check | Result |
| --- | --- |
| Privacy and brand | PASS |
| Workflow pinning | 5 workflow files passed |
| Governed network boundary | PASS. Production network access is confined to `GovernedFetchBroker` |
| Provider catalog | 278 verified routes, 209 unresolved routes retained separately |
| Strict TypeScript | Root and all workspaces passed |
| Workspace tests | Agent skill, desktop, installer, MCP, provider SDK, SDK type contracts, TUI, and workbench passed |
| Combined Vitest | 103 files, 680 tests passed |
| Coverage | 80.95 statements, 71.63 branches, 91.82 functions, 85.24 lines |
| JSON Schema | 53 schemas valid |
| Evaluator | 19 of 19 passed |
| Citation contract | 23 offline records passed |
| SBOM | 530 CycloneDX components parsed |
| Astro | 2 pages built |
| Package | Real tarball scan, production-only install, bundled SDK, external CLI, and bounded PDF and DOCX parser smokes passed |
| Dependency audit | Zero high-severity or higher npm vulnerabilities reported |
| Independent review | PASS. No open P0 or P1 finding |

Credential Passport focused tests use the official `eddsa-rdfc-2022` cryptosuite to generate and verify a real Open Badges compatible Data Integrity proof. The suite also rejects altered credential text, an issuer controller that no longer authorizes the key, an unavailable issuer document, and ambiguous multiple proofs. A separate route verifies a `did:key` issuer through the offline daemon resolver without a network delegate. Compact JWS verification remains independently covered.

VocationBench reports liveness precision `1.0`, dedupe F1 `1.0`, safety false allows `0`, false confirmations `0`, claim trace coverage `1.0`, and calibration ECE `0.0` on the shipped deterministic fixtures. These are internal benchmark results, not competitor superiority evidence. Competitor superiority remains `not-assessed`, and mutation score remains `not-evaluated`.

The workbench was exercised at 1440 by 900 and 390 by 844 through the real loopback gateway. Both routes had no horizontal overflow, clipped controls, console errors, or page errors. Rust `1.97.1` was installed locally from the official rustup distribution after checksum verification. Rust formatting, locked metadata, and dependency target checks passed locally. The machine does not include the MSVC linker, so Rust tests and Clippy remain authoritative in the dedicated Windows `desktop-native` workflow before merge.

An independent read-only review inspected the complete v0.6.0 diff against `origin/main`, including signed network grants, governed fetch and SSRF boundaries, persistent grant budgets, MCP capabilities, scoped approvals, loopback workbench protections, and release claims. It reported no supported P0 or P1 finding. The isolated reviewer could not execute Node or npm commands under its sandbox policy, so its static verdict supplements rather than replaces the complete local release gate above. A requested legacy Codex model identifier was unavailable for the authenticated account. The review was rerun with the supported default Codex model instead.

The first protected-branch run exposed four clean-platform release defects that stale local build output and missing Rust tooling had concealed. The SDK is now built before dependent workspace typechecks. Installer and benchmark reads are bound to the same validated file descriptor. Workbench route normalization uses bounded index and character operations. The Rust shell matches `rustfmt`. Focused regression tests and a fresh complete local release gate passed after remediation. Remote CodeQL and platform workflows remain authoritative before merge.

The second protected-branch run passed CodeQL, dependency review, and Ubuntu CI. Windows CI exposed a platform-specific direct symlink classification order, and the native build exposed the missing Windows icon consumed by `tauri-build`. Direct symlinks are now rejected before containment resolution. The desktop package includes validated PNG and ICO assets, `Cargo.lock`, Rust `1.97.1`, and `--locked` native test and Clippy commands. Local Rust formatting and locked metadata resolution passed. Local native linking was unavailable because this machine does not include the MSVC linker, so the dedicated Windows workflow remains the authority for Rust tests and Clippy.

The third protected-branch run passed CodeQL and both JavaScript platform jobs. Native Rust tests passed, then Clippy identified two denied warnings that were corrected with direct expression return and integer `div_ceil`. Dependency review identified `GHSA-wrw7-89jp-8q8g` in Tauri's Linux-only GTK graph. Stable Tauri `2.11.5` and Wry `0.55.1` still use that graph. Version 0.6 now fails closed to Windows `msi` and `nsis` targets. A dedicated dependency boundary gate proves the vulnerable package is absent from the supported Windows graph and makes the exact advisory exception stale on any upstream dependency drift.

The release remains source first. GitHub artifact attestation, SBOM attestation, and durable release evidence are produced by the tag workflow. No npm publish, native code-signing certificate, production auto apply adapter, independent compliance certification, or competitor superiority claim is part of this release.

GitHub pull request [#14](https://github.com/OnourImpram/vocation-os/pull/14) publishes the hash-verified release tree for protected-branch review and remote release gates.

## v0.5.0 Product Foundation Evidence

Version 0.5.0 adds product operations without enabling production auto apply. The release gate covers the following executable contracts.

1. Resumable onboarding uses an immutable initialization mode, a persisted active profile plan hash, immutable hashed events, optimistic concurrency, idempotent request replay, and persisted projection validation.
2. The encrypted artifact vault uses a dedicated credential, HKDF separated keys, authenticated content deduplication, bounded reads, durable writes, and source path minimization.
3. PDF, DOCX, Markdown, and UTF-8 profile sources parse in a bounded child process without plaintext disk fallback or inherited secret environment variables. PDF and DOCX inputs pass structural resource preflight. The built parser runs with read-only Node permissions, a pinned native canvas allowance required by PDF.js, network deny guards, a bounded heap, and confirmed timeout termination.
4. Profile import apply requires the exact persisted plan hash. Long source lines are split into lossless bounded segments and imports fail closed before the candidate ceiling can truncate data. Imported facts remain internal, Low confidence, operator supplied, and analysis only.
5. Document AST v2 requires complete claim trace coverage and canonical text hashes. Turkish and English PDF and DOCX outputs pass parse back verification before write.
6. Application tracker status changes use lifecycle specific operations. Approval is bound to one attempt and its expiry plus active signer status are rechecked immediately before submission. Generic application mutation is denied.
7. Answer memory resolves only exact prompt identities. Sensitive answers require per opportunity confirmation and restricted answers are assist only and non reusable.
8. Legacy import cache receipts must match the exact authenticated event. IPC bounds complete frame queues and pending handshakes separately from authenticated capacity. Long running operations expose stable request IDs for canonical retry recovery.
9. The golden product journey covers onboarding, discovery, document rendering, tracker creation, tasks, answer memory, and outcomes in one encrypted event chain.
10. Npm publication and production ATS execution remain outside this release. The real root tarball bundles the private SDK runtime, installs with production dependencies only, scans the installed release content, and executes its CLI and bounded document parser from an external consumer. Registry publication remains a separate release decision.

## v0.5.0 Final Local Evidence

Date: 2026-07-14

The final local release gate passed after adversarial remediation of receipt binding, generic application mutation, profile provenance, structural document claims, atomic rendering, trusted confirmation, daemon shutdown, concurrent onboarding, parser process lifecycle boundaries, attempt bound approvals, bounded IPC pressure, immutable onboarding mode, prompt bound answer memory, lossless profile import, operation specific IPC deadlines, and workflow supply chain pinning.

| Check | Result |
| --- | --- |
| Privacy scan | PASS |
| Brand scan | PASS |
| Workflow pinning | 4 workflow files passed |
| Strict TypeScript | PASS |
| Vitest | 55 files, 297 tests passed |
| Coverage | Configured thresholds passed: 80 statements, 68 branches, 85 functions, 80 lines |
| JSON Schema | 30 schemas valid |
| Selfcheck | PASS |
| Evaluator | 19 of 19 passed |
| Citation contract | 23 records passed offline validation |
| SBOM | CycloneDX generation and JSON parse passed |
| Astro | 2 pages built |
| Package | Real tarball content scan, production install, bundled SDK, external CLI, PDF parser, and DOCX parser passed |
| Windows daemon shutdown | Authenticated stop released the endpoint and single instance lock |

Exact coverage percentages and SBOM component counts can vary across Node and npm implementations. Canonical release CI is pinned by `.nvmrc` and `packageManager`. Release acceptance depends on configured coverage thresholds and successful SBOM generation and parsing, not an environment-sensitive component total.

The local release evidence was regenerated with `npm run safe:publish-check` on 2026-07-14. The workflow check also validates that GitHub Actions are pinned to immutable SHAs and that Node setup uses `.nvmrc`.

The release remains source first. No npm publish, production ATS execution adapter, or compliance certification is part of this pass.

This document records the VocationOS release engineering evidence. It is not a compliance certification.

## v0.4.0 Release Candidate

Date: 2026-07-11

Status: local release gate passed after independent P0 and P1 remediation review.

Base: clean `origin/main` checkout at `bcf30d67b4b9b96a2bc067ada543f679075a55e6`.

The previous dirty checkout was not modified.

## v0.4.0 Runtime Authority Evidence

The v0.4.0 pass moves consequential local runtime mutation behind `vocationd` and authenticated IPC. The shipped CLI still exposes read only, demo, validation, and backup or restore operations where direct store access is required under an exclusive local lock.

| Boundary | Evidence |
| --- | --- |
| Migration | Checksummed SQLite migrations replace implicit schema creation. |
| Legacy import | Dry run and apply paths are content bound, idempotent, and rollback backed. |
| Backup and restore | Encrypted envelope restore requires explicit overwrite approval and rolls back on failed verification. |
| Credentials | OS keyring and headless passphrase providers are separated and validated. |
| Authority | `vocationd` is a single writer with authenticated IPC, request MACs, request idempotency, and single instance locking. |
| Runtime policy | Caller supplied config, approver registries, ledger paths, document roots, and adapter allowlists do not override canonical authority state. |
| Checkpoints | Ed25519 signed event chain checkpoints detect rollback, deletion, tampering, and external digest mismatch. |
| Release truth | Package metadata, README metrics, architecture, threat model, roadmap, changelog, and pack surface now describe v0.4.0. |

The initial bounded architecture reviews identified preauthentication migration, split authority, idempotency, key custody, rollback, and checkpoint risks. The implementation and focused adversarial tests address those findings. A later read only review identified two additional P1 boundaries involving missing lock records and malformed evaluation inputs. Endpoint ownership now fails closed when a live daemon has no lock record, Unix active sockets cannot be replaced, evaluation contracts are validated before authoritative writes, and ledger entries are validated again at the write boundary. Independent focused rechecks found no remaining P0 or P1 issue.

## v0.4.0 Final Local Evidence

`npm run ci` passed after the final P1 remediation on 2026-07-11.

| Check | Result |
| --- | --- |
| Privacy scan | PASS |
| Brand scan | PASS |
| Strict TypeScript | PASS |
| Vitest | 41 files, 218 tests passed |
| JSON Schema | 20 schemas valid |
| Selfcheck | PASS |
| Evaluator | 19 of 19 passed |
| Documentation metrics | PASS |
| Citation contract | 23 records passed offline validation |
| SBOM | 411 components parsed |
| Astro | 2 pages built |
| Package | Build and pack surface check passed |
| Windows binary smoke | `vocationd` reached healthy state, applied 2 migrations, rejected a second daemon after lock deletion, retained authority, and persisted the manual kill state |

GitHub pull request [#5](https://github.com/OnourImpram/vocation-os/pull/5) publishes the verified `release/v0.4` tree for review. GitHub Actions run `29157345842` passed on both platforms. Ubuntu completed in 46 seconds and Windows completed in 1 minute 37 seconds.

No npm publish, registry deprecation, production signing key creation, or automatic merge is part of this release pass.

## v0.3.1 Release Candidate

Date: 2026-07-11

Status: release candidate gate passed locally.

Base: clean `origin/main` checkout at `8bd543f`.

The existing dirty checkout was not modified.

## Red to Green Security Evidence

Five adversarial probes were added before the implementation change. All five passed through the previous runtime:

1. R3 packet with `approvalRequired: false`.
2. Empty automation risk observation.
3. Caller usage count overriding a full ledger.
4. Unresolvable packet document.
5. A recency governed claim verified in 2010.

After the v0.3.1 fixes, all five probes fail closed.

## Implemented Release Controls

| Boundary | Control |
| --- | --- |
| Authorization | Approval is bound to opportunity, packet, adapter, action intent, allowed field, and expiry. |
| Risk | All automation and high stakes observations must be explicit. |
| Rate limit | Only ledger derived usage is authoritative. |
| Documents | Path boundary, existence, file type, and content hash are verified. |
| Evidence age | Named recency policies reject stale sources. |
| Kill switch | Kill, rearm, status, and enable use persistent atomic config. |
| Completion | Ed25519 collector receipt and trust registry replace caller asserted success. |
| Lifecycle | Prepared, approved, submitted unconfirmed, confirmed, and blocked transitions are enforced. |
| Privacy | SQLite event and snapshot payloads are authenticated and encrypted. |
| Agent separation | Worker roles, phase order, human approval, and independent evaluation are enforced. |
| Supply chain | Citation and SBOM checks are included in CI. |

Authorization now also requires an Ed25519 signature from a trusted approver registry. Forced scores bind approval to the exact rubric input hash and opportunity.

The secondary adversarial review identified six P1 issues. The remediation pass added a compile time production adapter block, stable user runtime root, signed approval authenticity, manifest enforced worker capabilities, authenticated event chain head, bounded proof reference IDs, and offline deterministic citation CI. Production execution remains blocked until daemon isolation and key custody ship.

The same independent reviewer rechecked those six findings against the remediation diff and marked all six resolved. Its focused verification passed 42 tests, strict TypeScript, and the 23 record offline citation contract. The primary review then accepted the fixes after the complete release gate passed.

## Validation Commands

```bash
npm run typecheck
npm run test
npm run validate:schemas
npm run evaluate
npm run citations:check
npm run sbom:check
npm run safe:publish-check
```

## Final Local Evidence

`npm run safe:publish-check` passed on 2026-07-11.

| Check | Result |
| --- | --- |
| Privacy scan | PASS |
| Brand scan | PASS |
| Strict TypeScript | PASS |
| Vitest | 28 files, 157 tests passed |
| JSON Schema | 17 schemas valid |
| Selfcheck | PASS |
| Evaluator | 19 of 19 passed |
| Citation contract | 23 records passed offline validation |
| SBOM | 398 components parsed |
| Astro | 2 pages built |
| Package | Build and pack surface check passed |

Online Crossref verification is available as the bounded optional command `npm run citations:check:online`. It is not a required CI dependency.

GitHub Actions run `29140868194` passed on the pull request branch. Ubuntu completed in 32 seconds and Windows completed in 1 minute 16 seconds.

## Distribution Boundary

This candidate is intended for GitHub review first.

No npm publish, registry deprecation, production signing key creation, or automatic merge is part of this release pass.
