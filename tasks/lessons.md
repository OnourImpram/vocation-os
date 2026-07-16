# Lessons

## 2026-07-17

Build internal type providers such as the SDK before any dependent workspace typecheck. A release gate must also be reproduced from a tree without ignored `dist` output so stale local builds cannot hide dependency ordering defects.

A size or path check followed by a second path based read is a TOCTOU boundary. Open once, validate the file descriptor, and read from that same descriptor.

Normalize uncontrolled route input with bounded index and character operations instead of repetition-sensitive regular expressions.

Desktop release validation requires the assets and native dependency lock that the platform build actually consumes. Keep the Tauri icon set, `Cargo.lock`, exact Rust toolchain, and `--locked` CI commands in the release contract.

A target-specific transitive advisory must not be silenced with an unguarded allowlist. Narrow the shipped platform contract, prove the package is absent from the supported target graph, bind the exception to the exact advisory and upstream path, and fail when dependency drift makes that reasoning stale.

Run Rust tests and Clippy with denied warnings before treating native validation as complete. A successful compile or test run does not prove the lint gate will pass.

## 2026-07-14

Keep source availability, parsed field availability, and action route liveness as separate contracts. A reachable provider payload may support extracted fields while the opportunity remains unresolved because a valid application endpoint is absent. Encode that distinction explicitly instead of weakening source observation invariants.

Do not spawn one shell process per binary candidate for support-status reporting. Resolve executables against a bounded PATH snapshot in-process so a diagnostic command cannot inherit network-path latency or exceed the test budget.

When Onour lists concrete capabilities while asking for a broad product program, do not reinterpret the list as a scope ceiling unless he explicitly says that the list is exhaustive.

Treat enumerated capabilities as mandatory minimums. Reconcile them with the existing roadmap, competitor baseline, product architecture, and release objective before reducing scope. Any deliberate deferral must be named, justified, and approved rather than silently omitted.

Network boundary checks must detect indirect transport aliases and injected global fetch references, not only direct `fetch()` calls. A claim that every egress route is governed requires scanner and runtime tests against aliases.

When workspace source files are included in coverage, their workspace tests must be included in the same coverage run. Counting source without its tests creates a misleading release signal.

## 2026-07-05

When external review text is shared in chat, treat it as implementation input unless the user explicitly says it exists on GitHub. Do not infer that it is already a public issue, PR comment, or review thread.

## 2026-07-12

Do not call a package surface verified after running its repository build or `npm pack --dry-run`. Install the real tarball into a clean production-only consumer and execute every shipped binary from an external working directory.

Every successful authority mutation, including an idempotent no-op, must commit a replayable authenticated event before its receipt. Receipt tables are reconstructable caches and must never override event-chain bindings.

Claim trace coverage includes every user-controlled visible string. Titles, labels, and headings must use fixed structural vocabulary or carry the same evidence binding as body content.

Idempotent mutation receipts are not current-state queries. Resume and status workflows must use unique mutation identities, then read the canonical aggregate after every state transition. A separate read then mutation sequence is not linearizable when the mutation reuses a historical receipt.

Plaintext receipt tables are caches, never authority. Before accepting an idempotent receipt, reconstruct and verify its exact request or import binding against the authenticated event chain. A receipt without its bound event is corruption and must fail closed.

An approval that authorizes an external effect must bind to one concrete attempt, not only to a reusable opportunity and packet tuple. Recheck expiry and active signer status at the final side-effect transition, not only when the approval is first attached.

Onboarding mode is immutable session state. A profile session cannot be resumed as demo, and any review handle needed for the next human decision must be recoverable from authenticated state after process or client restart.

Answer memory requires exact prompt identity plus sensitivity policy. Broad question type matching is insufficient for reuse, and restricted data is never eligible for approved automation.

Bounded extraction must not become silent data loss. Split oversized source material losslessly or fail closed before generating an approvable import plan.

Child-process promises must settle on spawn error, close, IPC delivery failure, and a hard timeout independent of child cooperation. A serialized authority queue cannot depend on receiving an `exit` event.

A parser response is not process termination evidence. Successful and failed response paths must retain forced-kill escalation until the child emits `close`.
