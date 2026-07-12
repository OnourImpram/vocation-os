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

Version 0.5.0 compiles only the synthetic `local-fixture` execution adapter. A config, caller, or plugin cannot enable a production ATS execution adapter. `vocationd` owns the runtime adapter decision, but no production execution adapter ships in this release.

Profile import does not convert extracted text into verified public claims. Candidates are stored as operator supplied, Low confidence, internal, and analysis only. Applying an import requires the exact persisted plan hash. PDF and DOCX parsing runs in a bounded local child process with structural resource preflight, an allowlisted environment, built-runtime read-only filesystem permissions, network deny guards, a bounded heap, confirmed timeout termination, and no plaintext disk fallback. PDF.js requires a pinned native canvas addon, so this boundary is process containment and input hardening rather than a complete operating system sandbox.

Document AST v2 rendering requires one verified claim and canonical text hash per content node. Structural text uses a constrained vocabulary and cannot carry free form claims. PDF and DOCX output must pass parse back verification before being written. Application records cannot bypass lifecycle transitions through generic put or archive operations. Confirmed attempts persist the signed collector proof, its evaluation, the lifecycle transition, and the ledger evidence together. EEO answers are not resolved for reuse, and legal, licensing, relocation, compensation, visa, and work authorization answers require per opportunity confirmation.

## Local Data Security

The encrypted event store uses SQLite WAL and FULL synchronous mode. Sensitive event and snapshot payloads and the canonical chain head use AES 256 GCM. Native installations keep separated secrets in the OS credential store. Headless installations use an AES 256 GCM credential vault whose key is derived with `scrypt` from a masked interactive passphrase. Plaintext, shell, argument, and environment variable secret fallbacks are not supported.

Checksummed migrations authenticate an existing store before writing and create a standard encrypted rollback backup before applying a newer schema. Legacy imports require a deterministic dry run plan hash, preserve source files, and create another encrypted rollback backup before mutation. Restore verifies the SQLite image, migration history, database identity, event count, and event chain head before an atomic swap.

Signed Ed25519 checkpoints bind the database identity, schema version, event count, chain head, prior checkpoint digest, device, and key. The latest digest is retained in the credential store to detect rollback of SQLite together with its internal chain head. This is tamper evidence, not an independent timestamp or remote notarization service.

The database retains opaque aggregate identifiers and operational metadata in plaintext. Sensitive profile payloads are encrypted.

Native OS credential storage is available through the optional `@napi-rs/keyring` binding. Headless use requires a masked interactive master passphrase and stores credentials only in an authenticated encrypted vault. Neither route has a plaintext fallback.

## Remaining Safety Boundaries

The daemon supports a local trusted collector registry. Production ATS collectors still require separately managed signing keys, adapter specific source policies, and their own release review.

Generic browser auto apply, CAPTCHA handling, anti bot bypass, hidden scraping, identity upload, payments, and employer side candidate decisions remain out of scope.
