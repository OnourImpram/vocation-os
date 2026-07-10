# VocationOS v0.3 Decision Intelligence Implementation Plan

Status: implementation in progress on `codex/v0.3-decision-intelligence`.

Date: 2026-07-10.

## Objective

Move VocationOS from a strong safety substrate into a usable career decision intelligence core without turning it into an unattended application bot.

The v0.3 release must make four claims true and testable:

1. Career advice is theory informed rather than theory decorated.
2. Model output remains advisory, local first, and structurally unable to authorize action.
3. Public job data enters through deterministic provenance preserving adapters.
4. An application is never marked confirmed without sufficient completion evidence.

## Review of the supplied upgrade pack

The supplied pack is technically substantive. It was applied to a clean worktree and independently reproduced the following baseline:

1. Strict TypeScript typecheck passed.
2. Thirteen test files passed.
3. Seventy two tests passed.
4. The existing claim, packet, ledger, reversibility, and auto apply gates remained green.

The following parts are accepted as the v0.3 foundation:

1. The operational theory registry and generated theory map.
2. Career decision difficulty intake.
3. Planned happenstance and acceptance process skill coaching at R0.
4. Advisory output sanitization and R0 enforcement.
5. Crossref based citation verification.

The supplied pack is not release complete by itself. It leaves four material gaps:

1. It does not ingest live opportunity data through a typed and provenance preserving contract.
2. It does not distinguish a submit attempt from a confirmed application through a dedicated proof verifier.
3. The remote advisory client lacks a host policy, timeout, response size limit, redirect policy, and explicit data egress approval.
4. Citation checks exist, but software supply chain evidence and a concrete threat model are still missing.

## Independent research findings

### Public ATS intake

Greenhouse exposes a public Job Board API for retrieving published jobs. Its application submission endpoint requires an API key and Greenhouse explicitly warns that the key must remain server side. VocationOS therefore supports Greenhouse read normalization only. It does not call the application POST endpoint.

Source: [Greenhouse Job Board API](https://developer.greenhouse.io/job-board.html).

Lever documents public posting fields including `hostedUrl`, `applyUrl`, `workplaceType`, plain text description fields, and optional salary data. VocationOS normalizes those public fields and does not use the candidate submission API.

Source: [Lever Postings API](https://github.com/lever/postings-api).

Ashby exposes a public job board endpoint for currently published jobs, including optional compensation data. VocationOS normalizes its published job payload and keeps submission outside the adapter boundary.

Source: [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api).

Schema.org and Google job posting guidance make an important distinction between a role being remote and an applicant being eligible from a particular location. `jobLocationType=TELECOMMUTE` alone is not enough. Applicant location requirements need their own evidence field.

Sources: [Schema.org JobPosting](https://schema.org/JobPosting) and [Google job posting structured data](https://developers.google.com/search/docs/appearance/structured-data/job-posting).

### Model and agent security

OWASP treats external job descriptions as an indirect prompt injection surface. Prompt fencing is useful, but it is not a security boundary. The reliable boundary is structural. Model output cannot call tools, mutate evidence, approve actions, or enter the auto apply input type.

Sources: [OWASP Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) and [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html).

NIST AI RMF emphasizes documented human oversight, clear responsibility, test and evaluation, and auditable go or no go decisions. VocationOS operationalizes this with explicit action state, proof evaluation, ledger entries, and a fail closed confirmation transition.

Sources: [NIST AI RMF 1.0](https://doi.org/10.6028/NIST.AI.100-1) and [NIST AI 600-1](https://doi.org/10.6028/NIST.AI.600-1).

### Release provenance

NPM can generate a CycloneDX or SPDX SBOM from package metadata. GitHub artifact attestations can bind a release artifact to its workflow identity. v0.3 adds an offline SBOM validation gate now and documents GitHub attestation as the release workflow target.

Sources: [npm sbom](https://docs.npmjs.com/cli/commands/npm-sbom/) and [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations).

## Target architecture

```text
Public ATS payload or manual opportunity
  -> source specific adapter
  -> normalized opportunity record plus source hash
  -> deterministic intake gate
  -> theory brief and fit analysis
  -> evidence bound application packet
  -> human approval and action gate
  -> submitted but unconfirmed attempt
  -> proof verifier
  -> confirmed application and ledger entry
```

The model is not in the state transition path. It can propose R0 narrative only. Deterministic code owns source normalization, evidence status, approval, action state, and proof validation.

## Implementation phases

### Phase 1. Theory and advisory foundation

Deliverables:

1. Twenty eight operational theory lenses.
2. Career decision difficulty classifier.
3. Skill coach with psychoeducational referral boundary.
4. Advisory note schema and hostile output sanitizer.

Acceptance:

1. Theory registry integrity is tested.
2. Advisory output is always `R0` and `advisoryOnly=true`.
3. Unknown theories and unsupported claim references are rejected.
4. Clinical sensitivity adds a referral boundary.

### Phase 2. Opportunity provenance and intake

Deliverables:

1. `OpportunityRecord` with canonical source, source id, URLs, location evidence, compensation signal, freshness, description hash, and capture timestamp.
2. Pure adapters for Greenhouse, Lever, Ashby, and manual input.
3. Intake policy for remote status, applicant location evidence, age, description quality, apply route, HTTPS, and duplicates.

Acceptance:

1. Adapters perform no network calls and no external writes.
2. The same payload always produces the same opportunity id and fingerprint.
3. Remote without applicant location evidence goes to manual review under strict policy.
4. Hybrid, on site, stale, duplicate, insecure, or missing route opportunities fail closed.

### Phase 3. Submission proof and lifecycle

Deliverables:

1. Typed proof records for confirmation page, ATS dashboard, Sent Items, and receipt email evidence.
2. A proof evaluator that rejects verification codes, incomplete notices, pending states, and unverified send calls.
3. An application attempt lifecycle with explicit `submitted_unconfirmed` and `confirmed` states.

Acceptance:

1. A submit call alone cannot produce `confirmed`.
2. Proof must match the opportunity id.
3. Official email proof requires Sent Items evidence and an attachment under the default policy.
4. A confirmation page requires a positive receipt indicator and no blocking or pending indicator.

### Phase 4. Remote model hardening

Deliverables:

1. Explicit local or remote client boundary.
2. Public data classification and explicit egress approval for remote calls.
3. HTTPS and host allowlist enforcement.
4. Request timeout, redirect rejection, content type validation, and maximum response size.

Acceptance:

1. Sensitive or unapproved context cannot leave the local process.
2. HTTP is rejected except explicitly allowed localhost development.
3. Redirects, oversized responses, and non JSON responses fail closed.
4. Private and unverified claims are never exposed as available advisory claims.

### Phase 5. Security and release evidence

Deliverables:

1. Threat model covering source input, indirect injection, egress, proof forgery, ledger tampering, and package supply chain.
2. Offline SBOM validation.
3. Updated CI, schemas, evaluator, documentation, and release checklist.

Acceptance:

1. Full offline CI passes.
2. Crossref citation resolution passes before release.
3. NPM package smoke test passes outside the repository.
4. Privacy and brand scans pass.
5. No unresolved critical or high severity adversarial finding remains.

## Deferred work

The following items remain outside v0.3:

1. Browser submission adapters.
2. CAPTCHA or anti bot handling.
3. Employer side candidate ranking.
4. Automatic email sending.
5. Encrypted private state.
6. Signed claim and packet bundles.
7. A full terminal user interface.

These items require separate threat models and should not be smuggled into a release whose primary goal is a trustworthy decision core.

## Release gate

The branch is release ready only when all of the following are true:

1. `npm run typecheck` passes.
2. `npm run test` passes.
3. `npm run validate:schemas` passes.
4. `npm run evaluate` returns `PASS`.
5. `npm run citations:check` resolves every DOI.
6. `npm run sbom:check` produces and validates an SBOM without network access.
7. `npm run safe:publish-check` passes.
8. The adversarial review verdict is `PASS` or `PARTIAL` with no unresolved critical or high severity finding.

