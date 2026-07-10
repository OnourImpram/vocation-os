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
| Theory grounding | Twenty eight cited theory lenses bind modes and rubric dimensions to primary sources in vocational psychology and decision science. |

## Quick Start

```bash
npm ci
npm run ci
npx tsx src/cli.ts help
npx tsx src/cli.ts demo-score
npx tsx src/cli.ts demo-opportunity-intake
npx tsx src/cli.ts demo-submission-proof
npx tsx src/cli.ts demo-auto-apply-decision
npx tsx src/cli.ts demo-auto-apply-allowed
```

## One Screen Architecture

```text
Operator intent
  -> Mode
  -> Public ATS adapter and opportunity provenance
  -> Remote and applicant location intake gates
  -> Evidence and claim graph
  -> Reversibility gate
  -> High stakes gate and specialist questions
  -> Packet hash and claim hash validation
  -> Human approval
  -> Submitted but unconfirmed attempt
  -> Submission proof verifier
  -> Confirmed action ledger entry
```

## Safety Architecture

VocationOS uses packet level claim validation before any allowed automation. A single unverified, private, or disallowed claim blocks an application packet. A kill switch blocks auto apply before every other gate. R4 actions never submit automatically.

Packet claims are bound to canonical claim text hashes. Stale packet hashes, changed claim text, duplicate packet claims, and missing automation risk signals block automation. A submission attempt remains `submitted_unconfirmed` until an official confirmation page, ATS record, Sent Items record, or receipt email passes the proof verifier.

The public repository includes only synthetic examples. Real private profile data belongs in ignored local state.

## Theory Engine and Advisory Layer

Every mode is bound to operational theory lenses in `src/theory.ts`, each with core constructs, runtime decision questions, rubric dimension bindings, and primary source citations. `docs/THEORY_MAP.md` is generated from the registry and DOIs are machine checked against Crossref with `npm run citations:check` before releases.

The optional advisory layer follows one rule: the model proposes, the gates dispose. Advisory notes are structurally locked to R0, may cite only public verified claims and mode applicable theory lenses, cannot change evidence status, and always carry an advisory disclaimer. Untrusted opportunity text is fenced as data, and hostile output is sanitized rather than trusted. Remote advisory calls require public data classification, explicit egress approval, HTTPS, an exact host allowlist, a timeout, redirect rejection, JSON content, and a response size limit. The `/skill-coach` mode turns the planned happenstance skills into psychoeducational micro practices paired with acceptance and commitment processes, with a named referral boundary when a clinical sensitivity flag is active.

## Opportunity Provenance and Completion Proof

VocationOS includes pure read adapters for public Greenhouse, Lever, and Ashby posting payloads. Adapters do not submit applications. They normalize source identity, canonical URLs, apply routes, remote policy, applicant location evidence, compensation signals, description hashes, freshness, and extraction confidence.

The intake gate treats remote status and applicant location eligibility as separate facts. A remote role with unknown eligibility geography moves to manual review under strict policy. Hybrid, on site, stale, duplicate, insecure, missing route, and thin description records fail closed.

Completion proof is also explicit. A form fill, send call, Outbox item, verification code, or incomplete application notice is not completion evidence. Proof records are hash bound and opportunity bound before they can move an application attempt to `confirmed`.

## Release Validation

The v0.3 release candidate extends the v0.2 validation surface with theory registry integrity, remote model egress controls, public ATS provenance, remote eligibility gates, proof bound confirmation, SBOM validation, and release artifact attestation.

See `docs/RELEASE_VALIDATION.md`, `docs/THREAT_MODEL.md`, and `docs/V0_3_IMPLEMENTATION_PLAN.md` for the release validation and architecture surface.

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
| Modes | 21 |
| Theories | 28 |
| Rubric dimensions | 20 |
| Schemas | 14 |
| CLI commands | 25 |
| Evaluator tests | 18 |

## Demo

```bash
npx tsx src/cli.ts demo-score
npx tsx src/cli.ts demo-steelman
npx tsx src/cli.ts demo-auto-apply-decision
npx tsx src/cli.ts demo-auto-apply-allowed
npx tsx src/cli.ts demo-skill-coach
npx tsx src/cli.ts demo-advisory
npx tsx src/cli.ts demo-opportunity-intake
npx tsx src/cli.ts demo-submission-proof
```

The advisory demo feeds a hostile model output through the sanitizer and shows it forced back to advisory only R0 with forged claim ids dropped. This proves the gate, not a failure.

The opportunity intake demo shows an explicit Europe eligible remote role passing source, route, duplicate, location, freshness, and description gates. The submission proof demo shows a real confirmation accepted and a security code rejected.

The auto apply demo is intentionally blocked because it includes a packet claim that is not verified. This proves the gate, not a failure.

The allowed local fixture demo shows the shape of an allowed decision after claim hash validation, packet hash validation, risk signal checks, rate limit checks, and structured approval.

## Governance Scope

VocationOS is designed for individual career decision support. It is not designed for employer side candidate ranking, filtering, rejection, or hiring decisions. Employer or platform deployment requires a separate compliance review.

Governance references are maintained in `GOVERNANCE.md` and `docs/NIST_AI_RMF_MAPPING.md`.

## Contributing

Every new mode requires schema, tests, docs, evaluator coverage, and high stakes assessment. Tests must never use real personal data. Guardrails must not be weakened to make tests pass.
