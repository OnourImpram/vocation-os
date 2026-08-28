# ADR-002, Three-Verification Contract

**Status:** Accepted

**Date:** 2026-08-28

## Context

Search engines, job aggregators, recruiter reposts, and cached pages can preserve vacancies long after they close. A single successful page fetch also does not prove that the employer, requisition, or application route is current. Acting on stale evidence wastes effort and can create inappropriate outreach.

## Decision

Every executable career opportunity requires three observations.

1. **Primary observation.** The exact official employer, institution, or ATS page must be live, substantive, and actionable.
2. **Independent observation.** A second authoritative source must corroborate the employer, role, requisition or canonical application route. A tracking-parameter variant, mirror, or copy of the primary feed is not independent.
3. **Pre-action observation.** The canonical route is checked again immediately before execution and must remain inside a short policy-defined age window.

The observations are immutable, timestamped, payload-hashed records. The resulting bundle is one of `incomplete`, `verified`, `expired`, `conflicted`, or `rejected`.

Material employer, role, requisition, opportunity identity, or live-status conflicts prevent verification. Expired evidence cannot authorise a side effect.

## Alternatives considered

### Search snippet plus direct link

Rejected. A snippet is discovery evidence, not live vacancy evidence.

### Two-source verification only

Rejected. A role can close between evaluation and submission.

### Provider confidence score

Rejected as an authority mechanism. Confidence assists triage but cannot replace explicit source observations.

## Consequences

The system may decline some genuine vacancies when independent evidence is unavailable. This is preferable to presenting uncertainty as proof. Manual review remains available, but manual review does not silently create an executable verified bundle.

## Migration and rollback

The contract is additive. Existing 0.6 opportunity records remain readable but cannot authorise the new 0.7 execution path until observations are collected. Rolling back to 0.6 ignores the new bundle records without changing historical source evidence.
