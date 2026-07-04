# Safety

VocationOS is a human supervised decision system.

## Non Negotiable Gates

1. The kill switch blocks first.
2. R4 actions are never auto submitted.
3. High stakes flags trigger certainty gates and specialist questions.
4. Every auto apply packet claim must be verified and publicly assertable.
5. Every auto apply packet claim must match canonical claim text and source claim text hash.
6. Stale packet hashes, duplicate packet claims, missing risk signals, and rate limit exhaustion block automation.
7. Weak evidence cannot become a precise public claim.
8. Completion requires confirmation evidence.

## High Stakes Areas

The system treats immigration, licensing, financial liability, clinical vulnerability, research integrity, conflict of interest, public reputation, and family relocation as high stakes signals.

High stakes mode outputs include specialist question templates at runtime.

## Integrity Controls

Claim text hashes and packet hashes are runtime gates, not display metadata. Any mismatch between graph claim text, packet claim text, source claim text hash, or packet hash blocks automation.

The action ledger uses unique action ids and rejects duplicate ids so blocked attempts and consequential actions remain auditable.
