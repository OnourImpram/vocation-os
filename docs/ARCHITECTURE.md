# Architecture

## Trust Layers

1. The deterministic Safety Kernel owns reversibility, high stakes, evidence, authorization, rate, and completion gates.
2. Career intelligence modules own temporal profile, opportunities, portfolio, documents, and outcomes.
3. Agent workers propose bounded artifacts through declared capability manifests.
4. Human approval is a distinct actor phase.
5. Adapters and collectors are constrained external boundaries.
6. The encrypted store persists private payloads and verifies event history.

## Runtime Flow

```text
CLI, typed SDK, and vocationd today, TUI, desktop, and extension later
  -> authenticated local IPC
  -> vocationd single writer
  -> versioned product repositories and encrypted artifact vault
  -> deterministic controller
  -> worker and model advisory processes
  -> schema and policy validation
  -> scoped human approval
  -> allowlisted adapter
  -> trusted collector
  -> encrypted event and outcome store
```

Version 0.5.0 exposes one command onboarding, profile import planning, product domain repositories, tracker operations, and read only or demo surfaces through the CLI. Consequential local runtime mutations go through `vocationd` as the authenticated single writer. Tauri and WXT are not yet shipped.

IPC uses length prefixed JSON frames with a one MiB limit. A random client nonce and server challenge authenticate with HMAC without transmitting the IPC secret. Per connection keys bind request and response MACs. Request sequences are monotonic. Mutating request IDs are durable and idempotent. Reusing an ID with different canonical parameters fails closed. Receipt rows are reconstructable caches. Replay also verifies the deterministic event ID and the request, operation, response, and hash binding inside the authenticated event.

## Data Authority

The claim graph remains the authority for public assertions.

The Career Digital Twin is the temporal profile authority target.

The encrypted SQLite event store is the canonical local runtime authority. Legacy JSON and JSONL files are import sources only. Import planning is write free and content bound. Apply requires the exact reviewed plan hash, preserves every source file, writes idempotency receipts, and creates an encrypted rollback backup.

Profiles, opportunities, Document AST records, campaigns, application attempts, tasks, outcomes, and answer memory are optimistic concurrency controlled encrypted aggregates. A shared mutation coordinator serializes domain writes across the one event chain. Generic application put and archive operations are blocked at the daemon boundary. Application lifecycle transitions use the tracker service.

The artifact vault stores CV, PDF, DOCX, and generated binaries under HMAC SHA 256 locators. AES 256 GCM encryption and locator keys are independently derived from a dedicated credential using HKDF. Manifests do not contain source paths or file names. Profile parsing receives decrypted bytes through local process IPC and never creates a plaintext parser file. PDF and DOCX resource preflight runs before fork. The built child receives read-only package and dependency access, network deny guards, a bounded heap, and hard timeout termination.

Profile import plans bind parser format, source manifest, extracted text hash, review candidates, and plan hash. Apply accepts only the exact persisted plan hash. The resulting profile stores full plan and source provenance. Imported identifiers are reserved from generic writes, and an existing record is accepted only when its complete value hash matches the approved plan. Imported facts remain `operator_supplied`, `Low` confidence, internal, and analysis only until a separate claim review changes their permitted use.

Application packets bind rendered claims and document hashes to one opportunity.

Approval references authorize one bounded action intent.

Approver and collector signatures establish origin inside separate trusted local registries owned by the local runtime authority. Registry management ships in v0.5.0. Production collector keys and ATS collectors do not.

Submission proofs record one collector observation bound to a unique application attempt and action intent. They cannot authorize an action. A successful confirmation stores the signed proof, deterministic evaluation, application transition, and confirmation ledger entry inside the same encrypted event.

Outcome events describe observed funnel stages. They do not imply causality.

## Cryptographic Boundary

SHA 256 hashes bind canonical content.

AES 256 GCM protects local event payload confidentiality and authenticity.

An authenticated event count and chain head detect suffix truncation while the current database and key boundary are retained.

Ed25519 verifies collector origin inside the configured local trust registry.

Ed25519 audit checkpoints bind database identity, migration version, event count, event chain head, previous checkpoint digest, device, and signing key. The latest digest is retained in the credential provider outside SQLite. This detects database rollback while that external digest remains trustworthy.

Native installations use the OS credential store. Headless installations use a separate AES 256 GCM credential vault derived from a masked interactive master passphrase with `scrypt`. Database, IPC, rollback, artifact vault, checkpoint, and external digest records remain separated. There is no plaintext or shell fallback.

Worker manifests bind actor identity, role, phase capability, tool allowlist, budget, timeout, and stop conditions. They are controller inputs, not an operating system sandbox. Process isolation remains roadmap work.

These controls do not replace platform receipts, legal signatures, independent timestamp authorities, or external compliance review.

The pure policy evaluator accepts injected state for deterministic tests. It is not a production side effect authority. v0.5.0 permits only a synthetic local fixture. Production config, ledger, approval registry, and adapter authority are behind `vocationd`, and real execution adapters still require a separate release gate.
