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
CLI today, desktop and extension later
  -> vocationd target boundary
  -> deterministic controller
  -> worker and model advisory processes
  -> schema and policy validation
  -> scoped human approval
  -> allowlisted adapter
  -> trusted collector
  -> encrypted event and outcome store
```

Version 0.3.1 exposes the controller modules directly through the CLI. `vocationd`, Tauri, and WXT are not yet shipped.

## Data Authority

The claim graph remains the authority for public assertions.

The Career Digital Twin is the temporal profile authority target.

Application packets bind rendered claims and document hashes to one opportunity.

Approval references authorize one bounded action intent.

Approver signatures establish origin inside a trusted local registry. Production key custody is not shipped in v0.3.1.

Submission proofs record one collector observation bound to a unique application attempt and action intent. They cannot authorize an action.

Outcome events describe observed funnel stages. They do not imply causality.

## Cryptographic Boundary

SHA 256 hashes bind canonical content.

AES 256 GCM protects local event payload confidentiality and authenticity.

An authenticated event count and chain head detect suffix truncation while the current database and key boundary are retained.

Ed25519 verifies collector origin inside the configured local trust registry.

Worker manifests bind actor identity, role, phase capability, tool allowlist, budget, timeout, and stop conditions. They are controller inputs, not an operating system sandbox. Process isolation remains roadmap work.

These controls do not replace platform receipts, legal signatures, independent timestamp authorities, or external compliance review.

The pure policy evaluator accepts injected state for deterministic tests. It is not a production side effect authority. v0.3.1 permits only a synthetic local fixture. Production config, ledger, approval registry, and adapter authority move behind `vocationd` before real execution adapters ship.
