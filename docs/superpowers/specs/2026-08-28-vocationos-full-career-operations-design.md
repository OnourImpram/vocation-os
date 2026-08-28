# VocationOS Full Career Operations Design

**Status:** Approved

**Date:** 2026-08-28

**Target line:** VocationOS 0.7

**Historical baseline:** VocationOS 0.6.2 remains immutable and available through the `v0.6.2` tag, release assets, and `support/0.6.x` branch.

## 1. Purpose

VocationOS 0.7 extends the current evidence-grounded career decision safety kernel into a bounded autonomous career operations platform. The product will discover opportunities, verify that they are real and actionable, assess fit and legitimacy, generate claim-bound application material, obtain a scoped execution grant, execute through allowlisted email and ATS adapters, verify completion through trusted collector receipts, classify replies, schedule follow-ups, and learn from confirmed outcomes.

The product must never optimise application volume by weakening evidence, safety, factual integrity, privacy, or completion proof. A prepared application is not a submitted application. An attempted action is not a confirmed action. A search result is not evidence that an opportunity is live.

## 2. Non-negotiable invariants

1. Existing `v0.6.2` history, tags, release artefacts, and security claims remain unchanged.
2. Production side effects are unavailable unless the adapter is compiled as shipped authority, explicitly allowlisted, covered by a valid execution grant, and bound to the exact action intent.
3. Every external opportunity or message is untrusted data, never executable instruction.
4. Every opportunity must pass primary liveness verification, independent corroboration, and an immediate pre-action recheck before execution.
5. Legitimacy is assessed separately from candidate fit.
6. No protected-trait answer is inferred or reused.
7. R4 actions, including signatures, payments, identity documents, binding legal attestations, offer acceptance, and banking disclosure, remain manual.
8. Every outbound command enters a transactional Outbox before execution.
9. Every command has an idempotency key and cannot be replayed after an ambiguous result until reconciliation completes.
10. Only trusted collector proof may transition an application from `submitted_unconfirmed` to `confirmed`.
11. Real user data remains local and encrypted. Public repository fixtures are synthetic.
12. No adapter bypasses CAPTCHA, anti-bot controls, login protections, identity checks, or platform terms.

## 3. Version and branch model

The repository uses the following development line.

- `support/0.6.x` preserves the 0.6 safety kernel and receives only compatible maintenance and critical security fixes.
- `next/0.7` is the integration branch for the new product line.
- Feature branches merge into `next/0.7` through reviewable pull requests.
- `main` receives the 0.7 line only after release-candidate validation.

The planned public progression is:

- `v0.7.0-alpha.1`, verification kernel, scoped grants, transactional Outbox, and a synthetic end-to-end adapter.
- `v0.7.0-alpha.2`, official email execution, Sent Items proof collection, reply intelligence, and follow-up state.
- `v0.7.0-beta.1`, browser sandbox and synthetic ATS contract suite.
- `v0.7.0-beta.2`, limited Greenhouse, Lever, and Ashby production pilots.
- `v0.7.0-beta.3`, SmartRecruiters and experimental Workday support.
- `v0.7.0-rc.1`, migration, control-room UI, security review, benchmark extension, and release evidence.
- `v0.7.0`, stable bounded autonomous career operations.

## 4. Architectural overview

```text
Career Intelligence
  -> Opportunity Observation and Normalisation
  -> Three-Verification and Legitimacy Kernel
  -> Fit, Work-Right, Licensing, and Compensation Gates
  -> Claim-Bound Application Planning and Document Generation
  -> Scoped Execution Grant
  -> Transactional Outbox
  -> Allowlisted Email or ATS Execution Adapter
  -> Trusted Submission Collector
  -> Application Lifecycle Confirmation
  -> Reply Intelligence and Follow-Up Scheduler
  -> Outcome Learning and Calibration
```

The current VocationOS agent phases remain authoritative:

```text
Observe -> Normalize -> Gate -> Plan -> Generate
        -> Evaluate -> Approve -> Execute -> Verify -> Learn
```

The generator cannot evaluate its own output. Only a human may approve. Only an application operator may execute. Only evidence-auditor and safety-governor roles may verify.

## 5. Opportunity verification contract

### 5.1 Source observations

A `VerificationObservation` records what a source showed at a particular time.

```ts
export type VerificationSourceKind =
  | "primary"
  | "independent"
  | "pre-action";

export type VerificationObservedStatus =
  | "live"
  | "closed"
  | "stale"
  | "unverifiable";

export interface VerificationObservation {
  observationId: string;
  opportunityId: string;
  sourceKind: VerificationSourceKind;
  sourceUrl: string;
  sourceDomain: string;
  employer: string;
  roleTitle: string;
  requisitionId: string | null;
  locationText: string;
  applyUrl: string | null;
  postedAt: string | null;
  deadlineAt: string | null;
  observedStatus: VerificationObservedStatus;
  capturedAt: string;
  payloadHash: string;
  extractionConfidence: "high" | "medium" | "low";
}
```

The source URL and apply URL must use HTTPS. Embedded credentials are rejected. Search snippets and cached mirrors cannot serve as the primary observation.

### 5.2 Source independence

The independent source must not be the same canonical domain and path family as the primary source, and must not be a mirror of the same feed. Independence evaluation returns explicit reasons and never upgrades uncertainty into a pass.

### 5.3 Bundle status

```ts
export type VerificationBundleStatus =
  | "incomplete"
  | "verified"
  | "expired"
  | "conflicted"
  | "rejected";
```

A bundle becomes `verified` only when:

1. primary observation is live,
2. independent observation corroborates employer, role, and requisition or canonical application route,
3. pre-action observation is live,
4. all observations refer to the same opportunity,
5. no material field conflict remains,
6. the pre-action observation is within the configured maximum age,
7. the bundle has not expired.

## 6. Legitimacy assessment

Legitimacy remains independent of fit.

```ts
export type LegitimacyTier = "green" | "yellow" | "red";

export interface LegitimacySignal {
  code: string;
  severity: "info" | "warning" | "blocking";
  evidence: string;
}

export interface LegitimacyAssessment {
  opportunityId: string;
  tier: LegitimacyTier;
  signals: LegitimacySignal[];
  assessedAt: string;
}
```

Blocking signals include payment requests, identity-document requests at an inappropriate stage, suspicious domains, unverifiable employer identity, inactive application routes, or explicit contradiction between primary and corroborating sources. Warning signals include repeated reposting, agency ambiguity, missing posting dates, or unusually persistent vacancies. The system reports observations rather than unsupported accusations.

## 7. Canonical opportunity identity and reposts

VocationOS stores three identities.

1. Source observation identity.
2. Canonical opportunity identity.
3. Repost cluster identity.

Canonical identity is resolved using this priority:

1. employer domain plus requisition ID,
2. canonical ATS apply route,
3. employer domain plus normalised title, location, employment type, and application route,
4. description and source-payload fingerprints.

Parallel roles must not be merged solely because titles are similar. City, level, language, business unit, and requisition differences remain material.

## 8. Scoped execution grants

A general user preference cannot grant execution authority. A signed `ExecutionGrant` binds authority to exact constraints.

```ts
export type CareerActionType =
  | "send-application-email"
  | "send-outreach-email"
  | "send-follow-up-email"
  | "submit-ats-application";

export interface ExecutionGrant {
  grantId: string;
  approvedBy: string;
  keyId: string;
  allowedAdapters: string[];
  allowedEmployerDomains: string[];
  allowedOpportunityTypes: string[];
  allowedActionTypes: CareerActionType[];
  allowedFields: string[];
  forbiddenFields: string[];
  minimumFitScore: number;
  allowedLegitimacyTiers: LegitimacyTier[];
  maxActions: number;
  maxActionsPerDay: number;
  validFrom: string;
  expiresAt: string;
  approvalTextHash: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}
```

Grant evaluation fails closed when the grant is expired, the adapter or action is outside scope, the employer domain is not allowed, the fit score is too low, legitimacy is not allowed, a requested field is forbidden, the total allowance is exhausted, or the daily allowance is exhausted.

## 9. Transactional Outbox

Every external command enters the Outbox before execution.

```ts
export type OutboxStatus =
  | "drafted"
  | "ready"
  | "reserved"
  | "executing"
  | "submitted_unconfirmed"
  | "confirmed"
  | "failed"
  | "suppressed";

export interface OutboxCommand {
  commandId: string;
  runId: string;
  opportunityId: string;
  attemptId: string;
  adapterId: string;
  actionType: CareerActionType;
  actionIntentHash: string;
  verificationBundleHash: string;
  packetHash: string;
  executionGrantId: string;
  targetDomain: string;
  documentHashes: string[];
  idempotencyKey: string;
  status: OutboxStatus;
  createdAt: string;
  updatedAt: string;
  reservedAt: string | null;
  executionStartedAt: string | null;
  blocker: string | null;
  proofId: string | null;
}
```

Allowed transitions are deterministic.

```text
drafted -> ready -> reserved -> executing -> submitted_unconfirmed -> confirmed
    |         |         |           |                  |
    +-------> failed / suppressed <--------------------+
```

A confirmed command is terminal. A failed command may be retried only through a newly derived command after reconciliation proves no external side effect occurred. A suppressed command cannot execute.

The idempotency key binds opportunity, attempt, action type, adapter, packet, verification bundle, grant, target domain, and document hashes.

## 10. Execution adapter contract

```ts
export interface ExecutionAdapter {
  manifest(): ExecutionAdapterManifest;
  inspect(context: AdapterInspectContext): Promise<AdapterInspection>;
  plan(context: AdapterPlanContext): Promise<AdapterExecutionPlan>;
  validate(plan: AdapterExecutionPlan): Promise<AdapterValidationResult>;
  preview(plan: AdapterExecutionPlan): Promise<AdapterPreview>;
  execute(command: SignedExecutionCommand): Promise<ExecutionObservation>;
  collect(
    attempt: ApplicationAttempt,
    observation: ExecutionObservation
  ): Promise<SubmissionObservationDraft>;
  reconcile(context: ReconciliationContext): Promise<ReconciliationResult>;
}
```

The manifest declares supported domains, channels, fields, forbidden fields, proof kinds, login and browser requirements, rate limits, recipe hash, adapter version, and last verification time.

An adapter name in configuration does not create authority. The adapter must be compiled into the shipped-adapter registry and allowed by a valid grant.

## 11. Alpha 1 executable scope

`v0.7.0-alpha.1` delivers a working synthetic end-to-end product slice.

It includes:

- typed three-verification observations and bundle evaluation,
- independent-source checks,
- legitimacy tiers and signals,
- signed execution grants and deterministic scope evaluation,
- transactional Outbox state transitions and idempotency,
- an execution-adapter interface,
- a compiled `career-ops-local-fixture` adapter restricted to synthetic profiles,
- trusted submission proof generation and confirmation through the existing lifecycle,
- an executable CLI demonstration,
- schemas, unit tests, red-team tests, documentation, and release notes.

Alpha 1 does not ship production email or ATS authority. This is an explicit product limit, not an unimplemented hidden promise. The slice proves the full control path before production adapters are introduced.

## 12. Production adapter roadmap

### Official email

The first production adapter will send verified official application or outreach email. It requires exact recipient-mailbox verification, attachment hashes, sender identity, scoped grant, rate limits, Sent Items receipt, message and thread identifiers, bounce suppression, and reply reconciliation.

### ATS adapters

The planned order is Greenhouse, Lever, Ashby, SmartRecruiters, then Workday. Each adapter begins with synthetic fixtures and contract tests, progresses through sandbox execution, and becomes production authority only after adversarial and limited-pilot evidence.

CAPTCHA, anti-bot, identity checks, unknown legal attestations, protected-trait questions, payment, and unknown required fields always stop execution.

## 13. Browser sandbox

ATS adapters execute in isolated contexts with explicit domain allowlists, disabled camera, microphone, clipboard, geolocation, and arbitrary downloads, bounded session state, typed field plans, network observation, page-state hashes, preview-before-submit, and context destruction after completion.

Page content cannot modify agent policy, tool authority, grants, or file access.

## 14. Reply and follow-up model

Inbound communication is classified as auto-confirmation, responded, need-action, interview, offer, rejection, bounce, security concern, noise, or unknown. Messages are matched using opportunity, employer, requisition, sender domain, message ID, and thread ID.

Default follow-up cadence is route-specific and bounded. Job applications begin around seven business days, B2B around five business days, academic outreach around seven to ten business days, and interview thanks within one business day when appropriate. Two unanswered follow-ups is the default maximum.

## 15. Privacy and public-repository rules

No real CV, recruiter email, message ID, cookie, session token, approval private key, passport, bank information, or application history may enter the public repository. Tests use synthetic people, employers, domains, documents, and keys. Real state remains in the encrypted local store.

## 16. Testing and release gates

Each behavioural change follows test-first development. Required suites include unit, schema, contract, red-team, privacy, recovery, replay, and synthetic end-to-end tests.

New gates added to the existing `safe:publish-check` line will include:

- verification-kernel checks,
- execution-grant checks,
- Outbox recovery and replay checks,
- adapter contract checks,
- browser sandbox checks,
- submission-receipt checks,
- Career Ops regression checks.

Stable release requires zero false confirmation in the frozen adversarial suite, zero duplicate submission in replay tests, zero protected-trait inference, zero CAPTCHA bypass, successful migration from 0.6.2, verified rollback, Windows and Linux CI, SBOM, and signed release provenance.

## 17. Attribution

Career Ops inspires filter-first evaluation, liveness gating, deep company research, contact targeting, follow-up cadence, repost analysis, and funnel learning. VocationOS implements these ideas through its own claim graph, deterministic controller, cryptographic approval, execution grant, encrypted ledger, adapter authority, and trusted receipt architecture. No Career Ops source code is copied.

## 18. Success criteria

The design succeeds when an operator can inspect a synthetic opportunity, observe three independently recorded verification steps, obtain a scoped grant, generate a claim-bound application packet, create exactly one idempotent Outbox command, execute through a shipped synthetic adapter, collect a trusted submission proof, confirm the application lifecycle, and inspect the complete audit trail.

Production success for later releases additionally requires controlled real email and ATS execution without stale listing actions, duplicate submissions, unsupported claims, protected-trait inference, or false completion records.
