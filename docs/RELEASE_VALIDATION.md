# Release Validation

This document records the public release validation surface for VocationOS. It is a release engineering note, not a compliance certification.

## v0.3 Decision Intelligence Release Candidate

Date: 2026-07-10

Verdict: PASS for branch and pull request readiness. Independent human or separate-model review remains a merge gate.

Scope: operational theory registry, decision difficulty intake, skill coach, advisory trust boundary, public ATS normalization, opportunity intake, submission proof lifecycle, schemas, evaluator, package surface, SBOM, and release attestations.

### Added blocker classes

| Risk class | Release control |
| --- | --- |
| Indirect prompt injection | Model output is isolated at R0, has no tool authority, and is sanitized against mode, theory, and claim allowlists. |
| Remote data egress | Remote advisory requires public classification, explicit egress approval, HTTPS, and an exact host allowlist. |
| Endpoint abuse | Redirects, oversized responses, non JSON content, embedded credentials, and insecure non local endpoints are rejected. |
| Untraceable opportunity | ATS payloads produce a source payload hash, description hash, canonical URL, and deterministic fingerprint. |
| False remote eligibility | Remote status and applicant location requirements are separate intake gates. |
| Duplicate or stale opportunity | Fingerprint and freshness gates reject unsafe intake. |
| False submission completion | Attempts stay submitted but unconfirmed until official proof passes validation. |
| Security code confusion | Verification code and resubmit messages are explicit negative proof indicators. |
| Proof tampering | Proof hashes are recomputed and proof is bound to the same opportunity before confirmation. |
| Proof privacy leakage | Proof source pointers accept only bounded `redacted:`, `local:`, or `proof:` references. Raw URLs and query data are rejected. |
| Invalid approval evidence | Approval identifiers, timestamps, operator names, and approval text hashes are validated before state transition. |
| Supply chain opacity | Offline CycloneDX SBOM validation and GitHub provenance plus SBOM attestations are part of the release surface. |

### Verification evidence

| Gate | Result |
| --- | --- |
| Strict TypeScript and full CI | PASS |
| Test suite | 18 files, 105 tests passed |
| Evaluator | 18 of 18 scenarios passed |
| JSON Schemas | 14 schemas compiled and validated |
| Research citations | 23 of 23 DOI records resolved |
| Dependency audit | 0 high severity production vulnerabilities |
| SBOM | CycloneDX document validated with 360 components |
| Package and site | Package smoke check and two page Astro build passed |
| Repository hygiene | Privacy, brand, documentation, narrative-marker, and diff checks passed |

The independent reviewer execution paths available in the local environment did not complete. One required an unavailable external model key and one timed out during tool startup. No reviewer result is represented as evidence. Merge should therefore retain an independent review requirement even though the executable release gates pass.

## v0.2 Public Release Candidate

Date: 2026-07-05

Verdict: GitHub public release candidate pass.

Scope: local CLI, schemas, synthetic examples, safety gates, governance documentation, package surface, and GitHub Pages microsite.

## Validated Blocker Classes

| Risk class | Release control |
| --- | --- |
| Claim text inflation | Packet claims must match graph claim text and source claim text hash. |
| Stale packet integrity | Application packet hash is recomputed from canonical packet JSON. |
| Duplicate audit identity | Action ledger ids use year scoped UUID identifiers and duplicate ids are rejected. |
| Broken package execution | `dist/cli.js` is built from `src/cli.ts` and checked from a temporary working directory. |
| Current working directory drift | Schemas and examples resolve from the package root, not caller working directory. |
| False state validation | State files are parsed, schema inferred when possible, and validated with AJV. |
| Unstructured authorization | Approval records use structured metadata and approval text hashes. |
| Hidden unsafe automation | Kill switch, reversibility, high stakes, risk signals, rate limits, packet claims, ToS status, and confirmation evidence are runtime gates. |

## Evidence Gates

The release gate is:

```bash
npm run safe:publish-check
```

That command runs privacy scanning, brand scanning, strict TypeScript checking, unit and red team tests, schema validation, selfcheck, evaluator checks, documentation checks, offline SBOM validation, site build, and package checks.

## Governance Boundary

This validation does not authorize employer side candidate ranking, filtering, rejection, or hiring decisions. VocationOS remains scoped to individual career decision support unless a separate compliance review is completed.

## Next Hardening Queue

1. Signed claim graph, application packet, and proof bundles.
2. Cryptographically chained action ledger.
3. Terminal review interface.
4. Calibration benchmark dataset.
5. Expanded manual red team script for high stakes and automation bypass attempts.
