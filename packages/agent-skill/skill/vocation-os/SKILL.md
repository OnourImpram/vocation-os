---
name: vocation-os
description: Use VocationOS for evidence grounded career discovery, review, documents, pipeline, approvals, audit, interviews, and offers. Activate when an agent needs to inspect or coordinate VocationOS through its daemon or MCP boundary.
license: MIT
compatibility: Requires a local VocationOS daemon or MCP endpoint. Side effects require a daemon capability and a scoped approval.
metadata:
  author: VocationOS
  version: "0.6.0"
---

# VocationOS

Use VocationOS as the authority for career operations. Keep the interaction read first and evidence bound.

## Workflow

1. Read health before relying on daemon, provider, or credential state.
2. Read Today, Discovery, Review, Twin, Documents, Pipeline, Evidence, Approvals, Audit, Credentials, Interview, Offers, or Settings as required by the task.
3. Distinguish verified records from inference. Preserve provenance and evidence identifiers in summaries.
4. Prepare a proposed command before any mutation. State the target, capability, expected version, approval scope, and expected receipt.
5. Send a side effect only through the daemon authority or an enabled MCP side effect tool. Require the exact capability and an unexpired approval bound to the tool arguments.
6. Read the resulting state and receipt. Treat a submission as unconfirmed until VocationOS records valid confirmation evidence.

## Authority Boundary

Never read or write VocationOS storage directly. Never call an application adapter directly. Never bypass expected version checks, capability checks, approval binding, or daemon idempotency.

The default MCP surface is read only. Tool annotations describe risk but do not grant authority. A side effect requires deterministic runtime enforcement even when a client offers its own confirmation prompt.

Do not place credentials, tokens, approval material, or private document contents in prompts, logs, manifests, or summaries. Use redacted status and identifiers.

## Failure Handling

Stop when health is unavailable, evidence is stale, approval is absent or expired, a version conflict occurs, or confirmation proof fails. Report the exact blocked state and the next read or approval needed. Do not reinterpret an attempted action as completion.
