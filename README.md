# VocationOS

Evidence grounded career decision safety for high agency operators.

![VocationOS decision control room banner](assets/vocationos-banner.png)

![CI](https://img.shields.io/badge/CI-configured-informational)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Safety](https://img.shields.io/badge/safety-red--team--tested-informational)
![License](https://img.shields.io/badge/license-MIT-green)

VocationOS is not a faster auto apply bot. It is a career decision safety system that makes automation conditional on evidence, reversibility, stakes, and human authorization.

Website: https://onourimpram.github.io/vocation-os/

## Why It Exists

Career decisions can look operationally simple while carrying hidden risk. A draft, a score, a profile statement, and a submitted application do not have the same reversibility. VocationOS keeps those differences explicit.

It helps an operator structure decisions, validate claims, score opportunities, generate evidence aware outputs, block unsafe automation, and preserve audit trails.

## What Makes It Different

| Pillar | Runtime control |
| --- | --- |
| Evidence | Claims carry evidence status and source pointers. Weak evidence cannot become precise public claims. |
| Reversibility | Actions use R0 to R4 tags so drafts, disclosures, submissions, and irreversible decisions are gated differently. |
| High stakes gates | Immigration, licensing, clinical, financial, research integrity, conflict, reputation, and relocation flags trigger certainty brakes. |
| Human authorization | Consequential actions require explicit approval and append only audit records. |

## Quick Start

```bash
npm ci
npm run ci
npx tsx src/cli.ts help
npx tsx src/cli.ts demo-score
npx tsx src/cli.ts demo-auto-apply-decision
npx tsx src/cli.ts demo-auto-apply-allowed
```

## One Screen Architecture

```text
Operator intent
  -> Mode
  -> Evidence and claim graph
  -> Reversibility gate
  -> High stakes gate and specialist questions
  -> Packet hash and claim hash validation
  -> Human approval
  -> Action ledger
```

## Safety Architecture

VocationOS uses packet level claim validation before any allowed automation. A single unverified, private, or disallowed claim blocks an application packet. A kill switch blocks auto apply before every other gate. R4 actions never submit automatically.

Packet claims are bound to canonical claim text hashes. Stale packet hashes, changed claim text, duplicate packet claims, and missing automation risk signals block automation.

The public repository includes only synthetic examples. Real private profile data belongs in ignored local state.

## What This Is Not

VocationOS is not an autonomous hiring system.

VocationOS is not a legal, immigration, clinical, financial, or licensing authority.

VocationOS does not rank, reject, or screen candidates for employers.

VocationOS does not fabricate credentials or convert weak evidence into precise claims.

VocationOS prepares, structures, critiques, and audits. The operator decides and authorizes.

## Metrics

The values below are checked by `npm run docs:check`.

| Metric | Count |
| --- | ---: |
| Modes | 20 |
| Theories | 25 |
| Rubric dimensions | 20 |
| Schemas | 8 |
| CLI commands | 21 |
| Evaluator tests | 14 |

## Demo

```bash
npx tsx src/cli.ts demo-score
npx tsx src/cli.ts demo-steelman
npx tsx src/cli.ts demo-auto-apply-decision
npx tsx src/cli.ts demo-auto-apply-allowed
```

The auto apply demo is intentionally blocked because it includes a packet claim that is not verified. This proves the gate, not a failure.

The allowed local fixture demo shows the shape of an allowed decision after claim hash validation, packet hash validation, risk signal checks, rate limit checks, and structured approval.

## Governance Scope

VocationOS is designed for individual career decision support. It is not designed for employer side candidate ranking, filtering, rejection, or hiring decisions. Employer or platform deployment requires a separate compliance review.

Governance references are maintained in `GOVERNANCE.md` and `docs/NIST_AI_RMF_MAPPING.md`.

## Contributing

Every new mode requires schema, tests, docs, evaluator coverage, and high stakes assessment. Tests must never use real personal data. Guardrails must not be weakened to make tests pass.
