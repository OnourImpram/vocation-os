# VocationOS 0.7 Alpha

VocationOS 0.7 begins the transition from evidence-grounded career decision safety to bounded autonomous career operations.

The historical `v0.6.2` release remains unchanged. This alpha line adds a working synthetic execution path that proves the complete control sequence before production email and ATS adapters are enabled.

## What alpha 1 executes

`v0.7.0-alpha.1` ships one compiled execution adapter:

```text
career-ops-local-fixture
```

It accepts only synthetic profiles and the synthetic target domain used by the test suite. It cannot send real email or submit a real ATS application.

The executable path is:

```text
primary verification
  -> independent corroboration
  -> immediate pre-action verification
  -> legitimacy assessment
  -> signed scoped execution grant
  -> claim-bound application packet
  -> transactional idempotent Outbox
  -> shipped synthetic adapter
  -> signed trusted collector proof
  -> confirmed application lifecycle
```

## Run the alpha

```bash
npm ci
npm run build
node dist/career-ops-cli.js adapters
node dist/career-ops-cli.js demo --at 2026-08-28T09:00:00.000Z
```

The adapter command must list exactly one synthetic adapter. The demo must return:

```json
{
  "verification": { "status": "verified" },
  "legitimacy": { "tier": "green" },
  "grantDecision": { "allowed": true },
  "outbox": { "status": "confirmed" },
  "applicationAttempt": { "status": "confirmed" },
  "proofEvaluation": { "status": "confirmed" }
}
```

The output contains no private key material or real personal data.

## New controls

| Control | Alpha 1 behaviour |
| --- | --- |
| Three-stage verification | Requires a live primary source, an independent authoritative source, and a current pre-action observation. |
| Source independence | Reusing the same canonical source family as corroboration is rejected. |
| Legitimacy | Payment, inappropriate identity-document requests, suspicious domains, and unverified employer identity block execution. |
| Scoped grant | Ed25519 signatures bind adapter, employer domain, action, fields, fit threshold, legitimacy tier, limits, and expiry. |
| Outbox | Every action follows a deterministic, immutable state machine and stable idempotency key. |
| Adapter authority | Configuration cannot activate an unshipped adapter. |
| Completion proof | The application remains unconfirmed until a trusted collector proof validates the exact attempt. |
| Red-team boundary | Stale evidence, wrong-source corroboration, expired grants, protected fields, non-synthetic profiles, and mismatched proofs fail closed. |

## Explicit limits

Alpha 1 does not:

- send real application email,
- submit Greenhouse, Lever, Ashby, SmartRecruiters, or Workday forms,
- bypass CAPTCHA or anti-bot controls,
- infer protected-trait answers,
- accept signatures, payments, identity documents, or binding legal attestations,
- mark an attempted action as complete without trusted proof.

Production email is the next separately reviewed milestone. Browser and ATS adapters follow only after synthetic contract, sandbox, replay, recovery, and adversarial test gates pass.

## Metrics

The values below are checked by `npm run docs:check` for the alpha branch.

| Metric | Count |
| --- | ---: |
| Modes | 21 |
| Theories | 28 |
| Rubric dimensions | 20 |
| Schemas | 59 |
| CLI commands | 73 |
| Evaluator tests | 19 |

## Development records

- [Approved architecture](superpowers/specs/2026-08-28-vocationos-full-career-operations-design.md)
- [Alpha 1 implementation plan](superpowers/plans/2026-08-28-vocationos-v0.7-alpha1-verification-outbox.md)

The feature branch targets `next/0.7`. The `support/0.6.x` branch and all published `0.6.x` tags remain available as the historical safety-kernel line.
