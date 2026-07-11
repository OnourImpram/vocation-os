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
CLI and vocationd today, desktop and extension later
  -> authenticated local IPC
  -> vocationd single writer
  -> deterministic controller
  -> worker and model advisory processes
  -> schema and policy validation
  -> scoped human approval
  -> allowlisted adapter
  -> trusted collector
  -> encrypted event and outcome store
```

Version 0.4.0 exposes read only and demo surfaces through the CLI, while consequential local runtime mutations go through `vocationd` as the authenticated single writer. Tauri and WXT are not yet shipped.

IPC uses length prefixed JSON frames with a one MiB limit. A random client nonce and server challenge authenticate with HMAC without transmitting the IPC secret. Per connection keys bind request and response MACs. Request sequences are monotonic. Mutating request IDs are durable and idempotent. Reusing an ID with different canonical parameters fails closed.

## Data Authority

The claim graph remains the authority for public assertions.

The Career Digital Twin is the temporal profile authority target.

The encrypted SQLite event store is the canonical local runtime authority. Legacy JSON and JSONL files are import sources only. Import planning is write free and content bound. Apply requires the exact reviewed plan hash, preserves every source file, writes idempotency receipts, and creates an encrypted rollback backup.

Application packets bind rendered claims and document hashes to one opportunity.

Approval references authorize one bounded action intent.

Approver signatures establish origin inside a trusted local registry owned by the local runtime authority. Production collector key custody is not shipped in v0.4.0.

Submission proofs record one collector observation bound to a unique application attempt and action intent. They cannot authorize an action.

Outcome events describe observed funnel stages. They do not imply causality.

## Cryptographic Boundary

SHA 256 hashes bind canonical content.

AES 256 GCM protects local event payload confidentiality and authenticity.

An authenticated event count and chain head detect suffix truncation while the current database and key boundary are retained.

Ed25519 verifies collector origin inside the configured local trust registry.

Ed25519 audit checkpoints bind database identity, migration version, event count, event chain head, previous checkpoint digest, device, and signing key. The latest digest is retained in the credential provider outside SQLite. This detects database rollback while that external digest remains trustworthy.

Native installations use the OS credential store. Headless installations use a separate AES 256 GCM credential vault derived from a masked interactive master passphrase with `scrypt`. Database, IPC, rollback, checkpoint, and external digest records remain separated. There is no plaintext or shell fallback.

Worker manifests bind actor identity, role, phase capability, tool allowlist, budget, timeout, and stop conditions. They are controller inputs, not an operating system sandbox. Process isolation remains roadmap work.

These controls do not replace platform receipts, legal signatures, independent timestamp authorities, or external compliance review.

The pure policy evaluator accepts injected state for deterministic tests. It is not a production side effect authority. v0.4.0 permits only a synthetic local fixture. Production config, ledger, approval registry, and adapter authority are behind `vocationd`, and real execution adapters still require a separate release gate.
