# Changelog

## 0.5.0

Local profile, document, and application operations release.

### Security hardening

1. Authority receipt replay now revalidates deterministic event and authenticated request bindings.
2. Application records reject generic put and archive mutation.
3. No-op mutations persist replayable command events before receipts.
4. Imported profiles store complete plan provenance and reject preseeded value mismatches.
5. Trusted collectors are daemon owned, and confirmed proof, evaluation, transition, and ledger evidence persist atomically.
6. Authenticated daemon shutdown and explicit headless provider guidance are available through the CLI.
7. Concurrent onboarding start and resume flows use unique mutation identities and reload the canonical aggregate instead of treating historical receipts as current state.
8. Profile parser lifecycle handling settles on spawn and IPC failures, rejects late success after timeout, and preserves forced termination for noncooperating child processes.
9. Release workflows pin first-party actions to reviewed commit identities and add CodeQL, dependency review, and Dependabot coverage.
10. The public license now uses the canonical MIT text, and package metadata declares its repository, support URL, website, and minimum Node version.
11. Legacy import receipts fail closed unless the exact source binding exists in the authenticated event chain.
12. Application approvals bind to one concrete attempt. Expiry and active signer status are rechecked at submission.
13. IPC enforces bounded frame queues, short pending handshakes, and separate authenticated capacity.
14. Onboarding mode is immutable, active profile plans are recoverable, and terminal progress requires persisted product prerequisites.
15. Answer reuse requires exact prompt identity. Sensitive and restricted answer policies are enforced at validation and resolution.
16. Profile imports split long lines into bounded lossless segments and fail closed before the candidate ceiling.
17. Long authority operations use operation-specific deadlines and return stable request IDs for canonical retry recovery.

### Added

1. Eight encrypted event sourced product repositories for profiles, opportunities, documents, campaigns, applications, tasks, outcomes, and policy bound answer memory.
2. A content addressed AES 256 GCM artifact vault with HKDF separated encryption and keyed locator keys, bounded reads, authenticated deduplication, symlink containment, and durable writes.
3. Resumable event sourced onboarding with immutable mode binding, active plan recovery, optimistic concurrency, deterministic replay validation, interruption recovery, and one command demo or profile initialization.
4. Isolated PDF, DOCX, Markdown, and UTF-8 profile parsing without plaintext disk fallback or inherited secret environment variables.
5. Hash bound profile import plans whose candidates remain operator supplied and analysis only until explicit claim review.
6. Document AST v2 with exact claim and text hash binding, Noto Sans multilingual PDF rendering, DOCX rendering, and mandatory parse back verification.
7. An event sourced application tracker that preserves approval, high stakes, and trusted collector confirmation transitions.
8. A golden local first journey covering onboarding, discovery, documents, tracker, tasks, answer memory, and outcomes in one encrypted runtime.

### Changed

1. Package version advanced to 0.5.0 and the typed local daemon SDK advanced to 0.2.0.
2. Product domain writes and onboarding mutations now route through authenticated `vocationd` operations.
3. Application records cannot be written through generic domain mutation. They require lifecycle specific tracker operations.
4. Npm publication remains deferred. Production execution adapters remain compile blocked.
5. Version 0.5.0 is finalized as a source-first GitHub release rather than an npm release.

## 0.4.1

Product engineering maintenance release candidate.

### Added

1. A real npm workspace boundary with the transport independent `@vocation-os/sdk` package.
2. Coverage thresholds for statements, branches, functions, and lines.
3. A compiled CLI subprocess smoke test that runs from outside the repository working directory.

### Changed

1. GitHub Actions use current checkout, Node setup, and artifact upload major versions.
2. Vitest and its V8 coverage provider are pinned to the same current major and exact version.
3. CI now builds the SDK before the root package and verifies the compiled CLI contract on Windows and Linux.

## 0.4.0

Canonical local runtime and authority release candidate.

### Added

1. `vocationd` package binary as the authenticated single writer for consequential local runtime mutations.
2. Authenticated IPC with request idempotency and replay safe command receipts.
3. Checksummed SQLite migrations and idempotent legacy import planning and execution.
4. Encrypted backup and crash safe restore with explicit overwrite approval.
5. Credential provider boundaries for OS keyring and headless passphrase operation.
6. Ed25519 signed event chain checkpoints and exportable audit bundles.
7. Adversarial coverage for migrations, imports, backup, restore, daemon IPC, single instance locking, checkpoints, and rollback detection.

### Changed

1. Package version advanced to 0.4.0.
2. Auto apply config mutations, legacy import, checkpoint creation, approver registry changes, and audit export now route through `vocationd`.
3. Release documentation now treats the encrypted event store as the canonical local runtime backend.
4. Production execution adapters remain compile blocked. Only a synthetic local fixture is enabled in v0.4.0.

## 0.3.1

Safety and platform foundation release candidate.

### Added

1. Signed scoped approvals bound to trusted approver, opportunity, packet, adapter, action intent, allowed fields, and expiry.
2. Complete automation and high stakes observation gates.
3. Policy based evidence recency and strict document path and hash validation.
4. Persistent kill switch configuration.
5. Trusted Ed25519 submission proof collectors and proof bound application lifecycle.
6. Greenhouse, Lever, Ashby, and manual opportunity provenance.
7. Operational 28 theory registry, skill coaching, and bounded advisory generation.
8. AES 256 GCM encrypted SQLite event store with snapshots, hash chain verification, and authenticated chain head.
9. Career Digital Twin, Document AST, portfolio, opportunity graph, outcome, and agent controller foundations.
10. VocationBench synthetic fixture generator and metric engine.
11. Deterministic citation and SBOM release checks, plus optional bounded Crossref verification.

### Changed

1. R3 authorization is derived from reversibility and cannot be disabled by packet input.
2. Rate limits use only authoritative ledger state.
3. Application completion cannot be inferred from caller supplied status text.
4. Package version advanced to 0.3.1.
5. Default runtime state moved from the current working directory to `VOCATION_HOME` or the user home.
6. Production execution adapters are compile blocked. Only a synthetic local fixture is enabled in v0.3.1.

## 0.2.0

Initial public VocationOS implementation with strict TypeScript, schema validation, claim graph, application packet gates, action ledger, red team tests, public release checks, and Decision Control Room microsite.
