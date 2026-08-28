# ADR-001, Production Execution Boundary

**Status:** Accepted

**Date:** 2026-08-28

## Context

VocationOS 0.6.2 compiled only a local synthetic fixture as execution authority. Configuration could not activate a production adapter. VocationOS 0.7 must eventually support real official-email and ATS execution without turning model output, plugin configuration, or a browser session into unrestricted authority.

## Decision

Production side effects remain behind a compiled adapter registry and deterministic daemon authority.

An adapter may execute only when all of the following are true:

1. its implementation is included in the shipped adapter registry,
2. its manifest passes schema validation,
3. a current three-stage verification bundle exists,
4. legitimacy is allowed by policy,
5. a signed scoped execution grant permits the exact adapter, employer domain, action type, and fields,
6. the application packet and documents are hash-bound,
7. a transactional Outbox command has been created and reserved,
8. the action intent and idempotency key are current,
9. no blocking automation-risk signal is present,
10. a trusted collector can produce the required completion proof.

Alpha 1 ships only `career-ops-local-fixture`, restricted to synthetic profiles and `synthetic.example`. Production email and ATS adapters are separate milestones.

## Alternatives considered

### Configuration-only enablement

Rejected. A compromised config file, model, or plugin could grant itself authority.

### General browser automation

Rejected. Unbounded browser control creates excessive access to credentials, files, unrelated domains, and page-supplied instructions.

### Direct adapter calls from agents

Rejected. It bypasses daemon version checks, scoped approval, idempotency, and trusted completion proof.

## Consequences

The product develops more slowly than a conventional form-filling bot, but every production adapter has an explicit threat model, contract suite, release status, and rollback path. A public claim that an adapter ships can be checked against compiled code and tests rather than configuration or documentation alone.

## Migration and rollback

VocationOS 0.6.2 remains available through its tag, release assets, and `support/0.6.x`. Removing a production adapter from the shipped registry immediately fails closed. Existing prepared or unconfirmed attempts remain auditable and cannot be silently promoted to confirmed.
