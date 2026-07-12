# Release Validation

## v0.5.0 Product Foundation Evidence

Version 0.5.0 adds product operations without enabling production auto apply. The release gate covers the following executable contracts.

1. Resumable onboarding uses immutable hashed events, optimistic concurrency, idempotent request replay, and persisted projection validation.
2. The encrypted artifact vault uses a dedicated credential, HKDF separated keys, authenticated content deduplication, bounded reads, durable writes, and source path minimization.
3. PDF, DOCX, Markdown, and UTF-8 profile sources parse in a bounded child process without plaintext disk fallback or inherited secret environment variables. PDF and DOCX inputs pass structural resource preflight. The built parser runs with read-only Node permissions, a pinned native canvas allowance required by PDF.js, network deny guards, a bounded heap, and confirmed timeout termination.
4. Profile import apply requires the exact persisted plan hash. Imported facts remain internal, Low confidence, operator supplied, and analysis only.
5. Document AST v2 requires complete claim trace coverage and canonical text hashes. Turkish and English PDF and DOCX outputs pass parse back verification before write.
6. Application tracker status changes use lifecycle specific operations. Generic application mutation is denied.
7. The golden product journey covers onboarding, discovery, document rendering, tracker creation, tasks, answer memory, and outcomes in one encrypted event chain.
8. Npm publication and production ATS execution remain outside this release. The real root tarball bundles the private SDK runtime, installs with production dependencies only, and executes its CLI and bounded document parser from an external consumer. Registry publication remains a separate release decision.

## v0.5.0 Final Local Evidence

Date: 2026-07-12

The final local release gate passed after adversarial remediation of receipt binding, generic application mutation, profile provenance, structural document claims, atomic rendering, trusted confirmation, daemon shutdown, concurrent onboarding, and parser process lifecycle boundaries.

| Check | Result |
| --- | --- |
| Privacy scan | PASS |
| Brand scan | PASS |
| Strict TypeScript | PASS |
| Vitest | 55 files, 284 tests passed |
| Coverage | 81.09 percent statements, 69.64 percent branches, 91.59 percent functions, 84.27 percent lines |
| JSON Schema | 30 schemas valid |
| Selfcheck | PASS |
| Evaluator | 19 of 19 passed |
| Citation contract | 23 records passed offline validation |
| SBOM | 462 components parsed |
| Astro | 2 pages built |
| Package | Real tarball production install, bundled SDK, external CLI, PDF parser, and DOCX parser passed |
| Windows daemon shutdown | Authenticated stop released the endpoint and single instance lock |

The final independent read only review returned PASS with no P0 or P1 finding. Its controlled probes verified bounded same-step conflict retry, canonical terminal result derivation, one-time parser settlement, forced termination without `close`, sanitized failure output, and zero remaining parser child handles.

The release candidate remains source first. No npm publish, production ATS execution adapter, automatic merge, or compliance certification is part of this pass.

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
