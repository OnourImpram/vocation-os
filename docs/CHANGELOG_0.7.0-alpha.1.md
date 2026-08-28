# VocationOS 0.7.0-alpha.1

**Release type:** Public prerelease

**Historical rollback target:** `v0.6.2`

## Added

1. Three-stage opportunity verification with immutable primary, independent, and pre-action observations.
2. Canonical source-family independence checks that reject tracking-parameter copies and same-source mirrors.
3. Verification bundle conflict, expiry, incomplete, rejection, and verified states.
4. Deterministic legitimacy assessment with separate Green, Yellow, and Red tiers.
5. Blocking signals for payment, inappropriate identity-document requests, suspicious contact domains, unverified employer identity, and non-current verification.
6. Warning signals for unknown agency employers, repeated reposting, missing posting dates, and limited extraction confidence.
7. Ed25519-signed scoped execution grants binding adapters, employer domains, opportunity and action types, allowed and forbidden fields, fit threshold, legitimacy tiers, quotas, and expiry.
8. Transactional Outbox commands with deterministic idempotency keys, fail-closed state transitions, reconciliation-required failures, and durable suppression.
9. A compiled execution-adapter contract and registry that configuration cannot extend.
10. Adapter-level grant revalidation during both planning and execution.
11. Command-bound execution observations covering the exact command, application attempt, action intent, verification bundle, packet, grant, plan, target domain, and idempotency key.
12. The `career-ops-local-fixture` adapter, restricted to synthetic profiles and the `synthetic.example` domain.
13. A synthetic end-to-end execution journey from verification through trusted collector proof and confirmed application lifecycle.
14. The directly executable `vocation-career` binary and compiled CLI smoke test.
15. Unit, golden-path, schema, and adversarial tests covering stale evidence, fake corroboration, red legitimacy, expired grants, malformed expectations, low fit, forbidden fields, non-synthetic profiles, replay, suppression reuse, observation grafting, payload tampering, proof mismatch, and negative confirmation signals.
16. Architecture specification, implementation plan, ADRs, Career Ops clean-room attribution, and a dedicated alpha product guide.

## Security

1. Search snippets and cached mirrors cannot authorise an action.
2. Pre-action evidence must be current inside a bounded execution window.
3. Legitimacy remains independent from fit, so a high-fit suspicious vacancy stays blocked.
4. Protected traits, identity documents, payment, and unsupported fields cannot be introduced through a broad grant.
5. Malformed execution expectations return controlled deny decisions rather than escaping policy evaluation as exceptions.
6. Identical external action intent produces a stable idempotency key across runs.
7. Failed commands retain their key until reconciliation, and suppressed commands permanently block key reuse.
8. A precomputed plan is insufficient by itself. The adapter revalidates the signed grant and exact scope at execution.
9. Collector evidence cannot be grafted across attempts or commands without invalidating observation integrity and proof binding.
10. Attempted execution remains `submitted_unconfirmed` until trusted proof binds the exact attempt, packet, adapter, and action intent.
11. Public tests and examples contain only synthetic identities, employers, documents, domains, and keys.
12. Production email and ATS adapters remain compile-blocked in this prerelease.

## Explicit limits

This prerelease is a working synthetic control-path product slice. It does not yet send real email or submit a real Greenhouse, Lever, Ashby, SmartRecruiters, or Workday application. The production adapter milestones remain separately reviewed and fail closed by default.
