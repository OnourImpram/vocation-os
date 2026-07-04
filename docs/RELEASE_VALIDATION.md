# Release Validation

This document records the public release validation surface for VocationOS. It is a release engineering note, not a compliance certification.

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

That command runs privacy scanning, brand scanning, strict TypeScript checking, unit and red team tests, schema validation, selfcheck, evaluator checks, documentation checks, site build, and package checks.

## Governance Boundary

This validation does not authorize employer side candidate ranking, filtering, rejection, or hiring decisions. VocationOS remains scoped to individual career decision support unless a separate compliance review is completed.

## Next Hardening Queue

1. Signed claim graph and signed application packet bundles.
2. SBOM and dependency provenance report.
3. Threat model document for claim graph, packet, adapter, and ledger trust boundaries.
4. Release artifact attestation before any npm publish decision.
5. Expanded manual red team script for high stakes and automation bypass attempts.
