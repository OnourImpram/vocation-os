# Changelog

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
