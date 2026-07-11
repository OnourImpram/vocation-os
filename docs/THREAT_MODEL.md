# Threat Model

## Protected Assets

1. Private Career Digital Twin facts.
2. Verified claim text and source provenance.
3. Application packet and document integrity.
4. Human authorization scope.
5. Submission completion truth.
6. Action and outcome history.
7. Collector signing keys and local store keys.

## Primary Adversaries

1. Malicious or injected opportunity content.
2. A model that invents or strengthens claims.
3. A plugin requesting excess capability.
4. A caller attempting approval replay or rate limit override.
5. A forged success message or altered proof.
6. A local database mutation.
7. Accidental publication of private profile artifacts.

## Enforced Mitigations

Opportunity content is fenced as untrusted data in advisory prompts.

Public documents require verified claim references.

Approval is scoped and expires.

Approval origin is verified against an Ed25519 trusted approver registry.

Risk and high stakes assessments are complete boolean records.

Collector receipts are signed, source constrained, attempt bound, action intent bound, and time checked.

Encrypted events are hash chained and authenticated. An encrypted chain head detects suffix truncation. Snapshots must bind to an aggregate event checkpoint.

Worker phase advancement requires a registered actor manifest and the phase specific read, write, or execute capability.

Privacy and brand scans operate as release gates.

## Residual Risks

A trusted collector private key compromise can produce apparently valid local receipts.

Opaque identifiers and operational metadata remain visible in the SQLite file.

The current local event chain has no independent external timestamp.

Full database deletion, replacement, or replay of both an old database and its encrypted chain head requires an external checkpoint to detect. Signed device checkpoints and OS credential storage remain roadmap work.

The v0.3.1 pure policy API is not an isolation boundary against malicious code in the same process. Consequential adapters are therefore compile blocked. The planned daemon must own authoritative config, ledger paths, approver registries, and adapter capabilities before production execution ships.

The initial opportunity concept matcher is deterministic and limited.

Desktop keychain, daemon isolation, plugin process sandboxing, production browser collectors, and recovery drills remain future work.
