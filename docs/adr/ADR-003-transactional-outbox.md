# ADR-003, Transactional Outbox and Idempotent Career Actions

**Status:** Accepted

**Date:** 2026-08-28

## Context

Email and browser submission are distributed side effects. A client can time out after the external system accepted an action. Retrying blindly can send duplicate outreach or submit the same application twice. Recording a local success before external confirmation can create a false completion record.

## Decision

Every outbound career action is represented by an immutable, schema-validated Outbox command before execution.

The command binds:

- run,
- opportunity,
- application attempt,
- adapter,
- action type,
- action-intent hash,
- verification-bundle hash,
- application-packet hash,
- execution-grant identity,
- target domain,
- document hashes,
- stable idempotency key.

The allowed state progression is:

```text
drafted -> ready -> reserved -> executing -> submitted_unconfirmed -> confirmed
```

Failure and suppression are explicit terminal or recovery states. `confirmed` is terminal and requires a trusted proof ID. Reservation requires an identified worker. No transition may skip required intermediate states.

The idempotency key is independent of the run ID. Re-running the same external action therefore produces the same key and must be detected before execution.

An ambiguous result enters reconciliation. The system inspects Sent Items, portal state, confirmation email, confirmation page, and existing application records before deriving a replacement command. A failed command is never simply reset and replayed.

## Alternatives considered

### Retry on transport failure

Rejected. Transport failure does not prove the side effect failed.

### Use the application tracker as the queue

Rejected. Application lifecycle state and transport-command state answer different questions and require separate audit histories.

### Random retry token

Rejected. Random tokens do not identify semantic duplicate actions across runs.

## Consequences

Execution requires more state and reconciliation logic. In return, duplicate submissions, false confirmations, orphan actions, and replayed approvals become explicit testable failure modes.

## Migration and rollback

Existing application attempts remain valid historical records. New 0.7 execution requires an Outbox command. Rolling back to 0.6 leaves Outbox records unread by the old runtime but does not alter confirmed application lifecycle data.
