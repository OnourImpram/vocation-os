# ADR-004, Command-Bound Execution Observations

**Status:** Accepted

**Date:** 2026-08-28

## Context

A trusted collector can confirm only what it actually observed. An execution observation that records merely a success phrase, target domain, and timestamp can be replayed or grafted onto a different application attempt for the same opportunity. That would allow valid-looking evidence to confirm the wrong packet, grant, plan, or Outbox command.

## Decision

Every execution observation is an immutable, schema-validated, payload-hashed record bound to:

- adapter ID,
- Outbox command ID,
- opportunity ID,
- application attempt ID,
- action-intent hash,
- verification-bundle hash,
- application-packet hash,
- execution-grant ID,
- idempotency key,
- execution-plan hash,
- source and target domains,
- captured and submitted timestamps,
- external reference ID,
- indicators,
- attachment count.

The observation payload hash covers every field except the hash itself.

Before collection, VocationOS verifies observation schema and payload integrity, then checks opportunity, attempt, action intent, packet, adapter, and synthetic-domain boundaries against the application attempt.

Before reconciliation, VocationOS additionally checks every Outbox and plan binding. A mismatched or tampered observation is `not-confirmed`, even when it carries a positive success indicator.

The adapter revalidates the signed execution grant during both planning and execution. A valid plan alone therefore cannot be replayed with an untrusted, expired, or differently scoped grant.

## Alternatives considered

### Bind only to opportunity and adapter

Rejected. Multiple attempts and packets may exist for the same opportunity.

### Let the collector rewrite observation identity from the attempt

Rejected. Rewriting can hide that the underlying observation came from another command.

### Rely only on a positive confirmation string

Rejected. A success phrase is content evidence, not identity or causality evidence.

### Trust a previously validated plan at execution

Rejected. The grant may have expired, been revoked from the trusted signer set, or been replaced between planning and execution.

## Consequences

Execution observations are larger and collectors must retain more bounded identifiers. In return, proof grafting, plan substitution, packet substitution, grant substitution, and command replay become explicit deterministic failures.

## Migration and rollback

The change is additive to the 0.7 alpha line. Existing 0.6 submission proof remains readable, but no new career-operations attempt may be confirmed through the 0.7 adapter path without a command-bound execution observation. Rolling back to `v0.6.2` removes the new path without modifying historical proof records.
