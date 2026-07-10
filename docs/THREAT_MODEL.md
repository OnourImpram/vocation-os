# VocationOS Threat Model

Status: v0.3 release candidate.

Date: 2026-07-10.

## Scope

This threat model covers individual career decision support. Employer side candidate ranking, unattended browser submission, identity verification, payment, and credential storage remain out of scope.

## Protected assets

1. Claim graph integrity.
2. Private profile and career history.
3. Application packet integrity.
4. Human approval authority.
5. Action and confirmation ledger integrity.
6. Remote model credentials.
7. Accurate opportunity provenance.
8. Accurate application completion state.

## Trust boundaries

```text
Public ATS payload
  -> untrusted source boundary
  -> deterministic adapter and source hash
  -> opportunity intake policy

Opportunity text
  -> indirect prompt injection boundary
  -> R0 advisory prompt
  -> output sanitizer
  -> no tool or state transition authority

Application action
  -> human approval boundary
  -> submitted_unconfirmed
  -> proof boundary
  -> confirmed and ledger eligible

Remote advisory
  -> explicit public data classification
  -> explicit egress approval
  -> HTTPS and host allowlist
  -> bounded JSON response
```

## Threats and controls

| Threat | Failure mode | Controls | Residual risk |
| --- | --- | --- | --- |
| Indirect prompt injection | A job description tells a model to ignore policy or authorize an action | Untrusted content fence, advisory only type, R0 schema constant, no tool authority, sanitizer, red team fixtures | A model may still produce misleading prose. Human review remains required. |
| Private data egress | Private claims or sensitive opportunity text are sent to a remote model | Public verified claim filter, data classification, explicit egress approval, remote boundary check | Incorrect caller classification remains possible. The caller owns classification truth. |
| SSRF or credential exfiltration | A configured endpoint redirects or points to an unapproved host | HTTPS requirement, exact hostname allowlist, embedded credential rejection, redirect rejection, timeout | DNS rebinding is not fully prevented. Use trusted model endpoints only. |
| Oversized or malformed model output | A remote endpoint consumes memory or bypasses parsing | Content type check, declared and measured byte limits, strict JSON parse, schema validation | A syntactically valid but low quality narrative still needs human review. |
| Source payload manipulation | ATS or copied job text contains hostile markup or false fields | Pure adapters, no script execution, source payload hash, typed normalization, explicit extraction confidence | Public employers can publish inaccurate content. Provenance does not establish truth. |
| Remote location ambiguity | Remote is mistaken for globally eligible | Separate remote policy and applicant location requirements, strict manual review when geography is missing | Location language remains heterogeneous and may require operator review. |
| Duplicate opportunity | Tracking parameters or mirrored boards create duplicate work | URL canonicalization and deterministic fingerprint | Materially changed reposts may require a new policy decision. |
| Stale opportunity | An old listing is scored or prepared | Posted date and configurable age gate | Some ATS sources expose update time rather than original publish time. Missing dates require review. |
| False submission completion | A send call, security code, incomplete message, or Outbox item is counted as complete | Explicit submitted unconfirmed state, proof schema, positive and negative indicator rules, Sent Items attachment policy | Visual changes in ATS confirmation text require new fixtures. |
| Proof record tampering | A proof indicator is changed after capture | Canonical proof hash and opportunity binding | Local filesystem compromise can replace both record and hash. Signed bundles remain future work. |
| Ledger inflation | Duplicate or unsupported confirmation entries are appended | Unique action ids, proof bound confirmed state, schema validation | The append only ledger is not yet cryptographically chained. |
| Dependency compromise | A release contains untracked or substituted dependencies | Lockfile install, package smoke test, CycloneDX SBOM check, GitHub provenance and SBOM attestation workflow | Registry compromise and compromised build dependencies remain ecosystem risks. |

## Security invariants

1. Model output cannot mutate evidence status.
2. Model output cannot approve or submit an application.
3. Remote model calls require public classification and explicit egress approval.
4. Unknown, private, or unverified claims cannot become advisory citations.
5. ATS adapters perform no external writes.
6. Remote work and applicant location eligibility are separate facts.
7. An attempted submission is not a confirmed application.
8. A security code is not completion evidence.
9. A proof hash must match before an application can be confirmed.
10. Only a proof bound confirmed attempt can create a confirmation ledger entry.

## Abuse cases that must remain blocked

1. CAPTCHA or anti bot bypass.
2. False work authorization or license claims.
3. Identity document, payment, or credential collection.
4. Employer side candidate screening or rejection.
5. Unattended mass application submission.
6. Remote egress of private profile content.
7. Treating a draft, form fill, send call, or security code as a completed application.

## Verification surface

The release test suite must include the following adversarial cases:

1. Prompt injection inside opportunity text.
2. Forged theory and claim identifiers.
3. Private claim text in model output.
4. Unapproved remote egress.
5. Non allowlisted and insecure model endpoints.
6. Non JSON and oversized model responses.
7. Hybrid or geographically incompatible opportunities.
8. Duplicate opportunity fingerprints.
9. Security code and incomplete application notices.
10. Proof tampering and opportunity mismatch.

