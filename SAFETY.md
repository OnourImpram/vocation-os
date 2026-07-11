# Safety

VocationOS is a human supervised, candidate side career decision system.

## Non Negotiable Gates

1. A persistent kill switch blocks before every automation gate.
2. Every Approved Auto action requires scoped human approval. R3 cannot be downgraded by packet metadata.
3. R4 actions never auto submit.
4. Every high stakes flag must be assessed explicitly. A positive flag blocks auto mode.
5. Every automation risk signal must be present as a boolean observation.
6. Every application claim must be verified, publicly assertable, allowed for use, and bound to canonical text.
7. Every packet document must resolve inside an explicit root and match its SHA 256 hash.
8. Recency governed evidence must satisfy its named policy window.
9. Rate limits are calculated from the authoritative ledger, never caller counters.
10. Completion requires a trusted collector signature bound to attempt, action intent, opportunity, packet, and adapter.
11. A generator cannot evaluate its own output.
12. Worker phases require registered role and capability manifests. Execute scopes are distinct from write scopes.
13. Only a human actor can perform the approval phase.

## Scoped Authorization

An `ApprovalReference` binds the opportunity ID, packet hash, adapter ID, action intent hash, allowed field, approver, approval time, and expiry. It is signed with Ed25519 and must verify against the trusted approver registry.

Approvals expire after at most 24 hours. Replaying approval against another opportunity, packet, adapter, or reversibility level fails closed.

The rearm phrase only disengages the kill switch. It does not enable automation.

## High Stakes Areas

Immigration, licensing, financial liability, clinical or mental health vulnerability, research integrity, conflict of interest, public reputation, and family relocation are high stakes signals.

High stakes routes produce specialist questions and manual decision packets. They do not produce automatic submissions or authoritative legal, clinical, licensing, or financial conclusions.

## Submission Proof Trust

Caller supplied success text is not completion evidence.

A valid `SubmissionProof` is created from a collector observation, signed with Ed25519, and verified against a trusted collector registry. The collector is constrained by adapter, source domain, proof kind, attempt ID, action intent hash, packet hash, opportunity, and capture time.

Negative signals such as verification code, incomplete application, resubmit, or failed submission override positive wording.

A local signature provides origin and tamper evidence within the configured trust boundary. It is not an independent public notarization.

Version 0.3.1 compiles only the synthetic `local-fixture` execution adapter. A config or plugin cannot enable a production ATS execution adapter. Production adapter authority waits for the isolated `vocationd` runtime.

## Local Data Security

The encrypted event store uses SQLite WAL and FULL synchronous mode. Sensitive event and snapshot payloads and the canonical chain head use AES 256 GCM. Keys are derived with `scrypt` in the headless implementation. Snapshots must reference a checkpoint in the same aggregate event chain and cannot roll back to an older stored version.

The database retains opaque aggregate identifiers and operational metadata in plaintext. Sensitive profile payloads are encrypted.

Desktop OS credential storage is roadmap work. Until that integration is complete, the headless store requires a passphrase and has no plaintext fallback.

## Remaining Safety Boundaries

Production ATS collectors require separately managed signing keys and adapter specific source policies.

Generic browser auto apply, CAPTCHA handling, anti bot bypass, hidden scraping, identity upload, payments, and employer side candidate decisions remain out of scope.
