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
8. A stale process, replayed IPC request, or second local writer.
9. A malformed PDF or DOCX designed to exhaust parser resources or carry active content.
10. SSRF, redirect rebinding, oversized responses, or poisoned discovery payloads.
11. False liveness, unsafe dedupe, taxonomy poisoning, or stale assurance evidence.
12. A forged, expired, revoked, wrong-subject, or algorithm-confused credential.
13. A local UI, MCP client, agent integration, or model provider requesting excess authority.

## Enforced Mitigations

Opportunity content is fenced as untrusted data in advisory prompts.

Public documents require verified claim references.

Approval is scoped to one concrete attempt and expires. Expiry and active signer status are rechecked at the submission transition.

Approval origin is verified against an Ed25519 trusted approver registry.

Risk and high stakes assessments are complete boolean records.

Collector receipts are signed, source constrained, attempt bound, action intent bound, and time checked.

Encrypted events are hash chained and authenticated. An encrypted chain head detects suffix truncation. Snapshots must bind to an aggregate event checkpoint.

Existing stores authenticate the key, SQLite image, event hashes, payload tags, and chain head before migrations can write. Migration checksums are verified on every open.

Daemon connections use challenge response HMAC, per connection message authentication, monotonic request sequences, bounded frames, bounded complete-frame queues, short pending-handshake deadlines, separate authenticated capacity, durable request receipts, and an exclusive process lock. Receipt replay is accepted only when the deterministic authenticated event carries the same request and response binding.

Legacy import receipts are untrusted cache entries until their source, locator, event metadata, and payload match an authenticated event.

Onboarding mode and active profile plan are event-projected state. Answer reuse requires exact prompt identity and sensitivity-policy eligibility. Profile extraction splits long lines and rejects candidate overflow instead of truncating facts.

PDF and DOCX imports use format and size limits, archive and PDF structure preflight, active content rejection, bounded extraction, a dedicated child process, built-runtime read-only permissions, network deny guards, a bounded heap, and confirmed timeout termination.

Worker phase advancement requires a registered actor manifest and the phase specific read, write, or execute capability.

Remote discovery is denied unless a signed grant binds host, provider, purpose, retention, and expiry. The fetch broker revalidates DNS and redirects, blocks private address space, bounds content and time, enforces content types and rate policy, and records an egress manifest.

Opportunity truth separates observed, inferred, conflicting, stale, and unresolved fields. Liveness requires positive provider identity and application state evidence. Dedupe ambiguity is conservatively projected to human review. Taxonomy mappings retain source snapshot and deterministic mapping provenance.

Credential import separates schema, signature, issuer, subject, temporal, revocation, and refresh checks. Compact JWS and `eddsa-rdfc-2022` verification bind the credential bytes to a permitted algorithm, verification method, and issuer-authorized assertion relationship. Standard JSON LD contexts and `did:key` material resolve from a pinned local trust set. Other issuer material must pass through an injected bounded loader. Multiple Data Integrity proofs, missing controller evidence, unsupported cryptosuites, altered content, and unauthorized keys fail closed. Mapping a credential to a career claim requires explicit review and defaults to nonpublic, non-automation use. A verified signature is not treated as real-world claim verification.

The TUI, workbench, MCP, agent skill, and model gateway are clients of daemon authority. They cannot write protected decision records or enable a production execution adapter. The loopback workbench uses bearer, CSRF, capability, and origin controls.

Privacy and brand scans operate as release gates.

## Residual Risks

A trusted collector private key compromise can produce apparently valid local receipts.

Opaque identifiers and operational metadata remain visible in the SQLite file.

The current local event chain has no independent external timestamp.

Full database deletion, replacement, or replay of both an old database and its encrypted chain head requires an external checkpoint copy or retained signing context to detect. Signed checkpoints and credential provider boundaries now exist, but external archival and recovery drills remain required for full device compromise.

Administrator access, root access, compromised OS credentials, malicious code already executing as the same operating system user, and simultaneous rollback of both SQLite and its external credential state remain outside the local daemon guarantee.

Pending-handshake and frame-queue limits bound local IPC resource use, but they do not promise availability against a process that already controls the same operating system account and can reconnect continuously.

The pure policy API is not an isolation boundary against malicious code in the same process. Consequential adapters are therefore compile blocked. `vocationd` now owns authoritative config, ledger paths, approver registries, and adapter capabilities before production execution ships.

PDF.js requires a pinned native canvas addon. Node permissions and network guards reduce the child process surface, but native code means the parser is not equivalent to a container, low integrity operating system token, or virtual machine. Untrusted documents should remain within the configured size and structure limits, and parser dependencies require ongoing security review.

The deterministic taxonomy matcher is bounded by the imported ESCO, O*NET, and local snapshot coverage. It is not a learned labor market model.

The default daemon credential resolver is offline and supports pinned contexts plus `did:key`. Verifying HTTPS issuer material requires a separately governed document loader. Open Badges schema validation, status list resolution, and refresh remain independent checks and can leave a cryptographically valid credential incomplete.

Plugin process sandboxing, a production browser extension, production execution and proof collectors, external checkpoint archival, independent timestamping, portable recovery drills, and live competitor baseline evidence remain future work.
