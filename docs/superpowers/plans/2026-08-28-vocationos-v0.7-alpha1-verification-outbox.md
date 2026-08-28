# VocationOS 0.7 Alpha 1 Verification and Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a working synthetic end-to-end VocationOS 0.7 alpha that enforces three-stage opportunity verification, legitimacy assessment, scoped execution grants, a transactional idempotent Outbox, and confirmation through a shipped synthetic execution adapter.

**Architecture:** New focused modules live under `src/career-ops/` and reuse the existing schema registry, application lifecycle, approval cryptography, submission-proof collector, and CLI patterns. The alpha proves the full Observe-to-Verify control path with synthetic data while preserving the production execution boundary. No real email or ATS adapter ships in this milestone.

**Tech Stack:** TypeScript 5.8, Node 22.23.1, AJV JSON Schema, Ed25519 signatures from `node:crypto`, Vitest, existing VocationOS lifecycle and submission-proof modules.

**Spec:** `docs/superpowers/specs/2026-08-28-vocationos-full-career-operations-design.md`

## Global Constraints

- Preserve `v0.6.2`, the `v0.6.2` tag, release artefacts, and the `support/0.6.x` maintenance branch.
- Work only on `feat/v0.7-alpha1-verification-outbox`, targeting `next/0.7`.
- Node must remain `>=22.13.0`; `.nvmrc` remains authoritative.
- No production email or ATS execution authority in alpha 1.
- Public fixtures must be synthetic and must not contain real personal or employer data.
- All external text is untrusted data and cannot alter policy or authority.
- Every new behaviour follows red, green, refactor TDD.
- Every new structured record must have a strict JSON schema registered in `src/schema.ts`.
- Every command and state transition must fail closed on missing or stale evidence.
- No completion claim without a trusted submission proof.
- Existing `npm run ci` must remain green on Ubuntu and Windows.

---

## File map

### New production files

- `src/career-ops/verification.ts`, verification observations, independence evaluation, bundle creation, conflict and expiry evaluation.
- `src/career-ops/legitimacy.ts`, typed legitimacy signals and deterministic tier evaluation.
- `src/career-ops/execution-grant.ts`, signed scoped execution grants and grant-scope evaluation.
- `src/career-ops/outbox.ts`, Outbox command creation, idempotency, allowed transitions, reservation, failure, and confirmation binding.
- `src/career-ops/execution-adapter.ts`, adapter contracts and shipped-adapter registry.
- `src/career-ops/local-fixture-adapter.ts`, synthetic-only adapter and trusted proof collector.
- `src/career-ops/demo.ts`, deterministic end-to-end alpha demonstration.

### New schemas

- `schemas/verification-observation.schema.json`
- `schemas/opportunity-verification-bundle.schema.json`
- `schemas/legitimacy-assessment.schema.json`
- `schemas/execution-grant.schema.json`
- `schemas/outbox-command.schema.json`
- `schemas/execution-adapter-manifest.schema.json`

### Modified production files

- `src/schema.ts`, register six new schemas.
- `src/types.ts`, add the CLI command and any shared literal unions that must be public.
- `src/cli.ts`, import and dispatch the alpha demonstration.
- `package.json`, set version to `0.7.0-alpha.1` only after behavioural tasks pass.
- `README.md`, document alpha scope and explicit production limits.
- `CHANGELOG.md`, add the alpha release entry.

### New tests

- `test/unit/career-ops-verification.test.ts`
- `test/unit/career-ops-legitimacy.test.ts`
- `test/unit/career-ops-execution-grant.test.ts`
- `test/unit/career-ops-outbox.test.ts`
- `test/unit/career-ops-adapter.test.ts`
- `test/golden/career-ops-alpha-journey.test.ts`
- `test/red-team/career-ops-execution.test.ts`

---

### Task 1: Three-stage verification records and schemas

**Files:**
- Create: `test/unit/career-ops-verification.test.ts`
- Create: `src/career-ops/verification.ts`
- Create: `schemas/verification-observation.schema.json`
- Create: `schemas/opportunity-verification-bundle.schema.json`
- Modify: `src/schema.ts`

**Interfaces:**
- Produces: `VerificationObservation`, `OpportunityVerificationBundle`, `VerificationPolicy`, `createVerificationObservation(draft)`, `evaluateVerificationBundle(input)`.
- Consumes: `sha256`, `stableStringify`, `assertSchema`, URL normalisation conventions from `src/opportunity.ts`.

- [ ] **Step 1: Write the failing verification tests**

```ts
import { describe, expect, test } from "vitest";
import {
  createVerificationObservation,
  evaluateVerificationBundle
} from "../../src/career-ops/verification.js";

const base = {
  opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
  employer: "Synthetic Research Labs",
  roleTitle: "Research Operations Lead",
  requisitionId: "REQ-001",
  locationText: "Remote, European Union",
  postedAt: "2026-08-27T08:00:00.000Z",
  deadlineAt: "2026-09-10T21:00:00.000Z",
  observedStatus: "live" as const,
  extractionConfidence: "high" as const
};

test("accepts three current consistent observations from independent source families", () => {
  const primary = createVerificationObservation({
    ...base,
    sourceKind: "primary",
    sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/1001",
    applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app",
    capturedAt: "2026-08-28T08:00:00.000Z",
    sourcePayload: { status: "open" }
  });
  const independent = createVerificationObservation({
    ...base,
    sourceKind: "independent",
    sourceUrl: "https://synthetic.example/careers/research-operations-lead",
    applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app",
    capturedAt: "2026-08-28T08:02:00.000Z",
    sourcePayload: { requisition: "REQ-001" }
  });
  const preAction = createVerificationObservation({
    ...base,
    sourceKind: "pre-action",
    sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/1001",
    applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app",
    capturedAt: "2026-08-28T08:05:00.000Z",
    sourcePayload: { status: "open" }
  });

  const result = evaluateVerificationBundle({
    opportunityId: base.opportunityId,
    primary,
    independent,
    preAction,
    policy: { maximumPreActionAgeSeconds: 600, bundleLifetimeSeconds: 3600 },
    evaluatedAt: "2026-08-28T08:06:00.000Z"
  });

  expect(result.status).toBe("verified");
  expect(result.reasons).toEqual([]);
});

test("rejects a search mirror as independent corroboration", () => {
  const primary = createVerificationObservation({
    ...base,
    sourceKind: "primary",
    sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/1001",
    applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app",
    capturedAt: "2026-08-28T08:00:00.000Z",
    sourcePayload: { status: "open" }
  });
  const independent = createVerificationObservation({
    ...base,
    sourceKind: "independent",
    sourceUrl: "https://boards.greenhouse.io/synthetic/jobs/1001?utm_source=mirror",
    applyUrl: "https://boards.greenhouse.io/synthetic/jobs/1001#app",
    capturedAt: "2026-08-28T08:02:00.000Z",
    sourcePayload: { status: "open" }
  });

  const result = evaluateVerificationBundle({
    opportunityId: base.opportunityId,
    primary,
    independent,
    preAction: null,
    policy: { maximumPreActionAgeSeconds: 600, bundleLifetimeSeconds: 3600 },
    evaluatedAt: "2026-08-28T08:03:00.000Z"
  });

  expect(result.status).toBe("rejected");
  expect(result.reasons).toContain("independent observation is not source-independent");
});
```

- [ ] **Step 2: Commit the failing tests and confirm CI fails for the missing module**

Create a pull request from the feature branch to `next/0.7`, then wait for the Ubuntu and Windows `ci` jobs. Expected failure is module resolution for `src/career-ops/verification.js`.

- [ ] **Step 3: Implement minimal verification records**

Implement strict URL handling, deterministic IDs and payload hashes, source-domain extraction, schema assertions, material-field consistency, source independence, current pre-action age, and bundle expiry. Do not include legitimacy logic in this module.

- [ ] **Step 4: Add strict schemas and schema registry entries**

The observation schema must disallow additional properties and validate IDs, HTTPS URLs, timestamps, SHA-256 hashes, nullable fields, and literal unions. The bundle schema must validate observation references, status, reasons, evaluated time, expiry, and bundle hash.

- [ ] **Step 5: Verify targeted and full tests pass**

Run through CI:

```bash
npm test -- test/unit/career-ops-verification.test.ts
npm run validate:schemas
npm run typecheck
```

Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/career-ops/verification.ts schemas/verification-observation.schema.json schemas/opportunity-verification-bundle.schema.json src/schema.ts test/unit/career-ops-verification.test.ts
git commit -m "feat: add three-stage opportunity verification"
```

### Task 2: Deterministic legitimacy assessment

**Files:**
- Create: `test/unit/career-ops-legitimacy.test.ts`
- Create: `src/career-ops/legitimacy.ts`
- Create: `schemas/legitimacy-assessment.schema.json`
- Modify: `src/schema.ts`

**Interfaces:**
- Consumes: `OpportunityVerificationBundle` from Task 1.
- Produces: `LegitimacySignal`, `LegitimacyAssessment`, `assessLegitimacy(input)`.

- [ ] **Step 1: Write failing legitimacy tests**

```ts
import { describe, expect, test } from "vitest";
import { assessLegitimacy } from "../../src/career-ops/legitimacy.js";

const verifiedBundle = {
  opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
  status: "verified" as const,
  primaryObservationId: "OBS-PRIMARY",
  independentObservationId: "OBS-INDEPENDENT",
  preActionObservationId: "OBS-PREACTION",
  reasons: [],
  evaluatedAt: "2026-08-28T08:06:00.000Z",
  expiresAt: "2026-08-28T09:06:00.000Z",
  bundleHash: "sha256:" + "a".repeat(64)
};

test("returns green when verification is current and no warning signals exist", () => {
  const result = assessLegitimacy({
    opportunityId: verifiedBundle.opportunityId,
    verification: verifiedBundle,
    observations: {
      paymentRequired: false,
      identityDocumentRequested: false,
      suspiciousContactDomain: false,
      agencyEmployerUnknown: false,
      repostCount90Days: 0,
      employerIdentityVerified: true
    },
    assessedAt: "2026-08-28T08:07:00.000Z"
  });
  expect(result.tier).toBe("green");
});

test("returns red when payment is required before application", () => {
  const result = assessLegitimacy({
    opportunityId: verifiedBundle.opportunityId,
    verification: verifiedBundle,
    observations: {
      paymentRequired: true,
      identityDocumentRequested: false,
      suspiciousContactDomain: false,
      agencyEmployerUnknown: false,
      repostCount90Days: 0,
      employerIdentityVerified: true
    },
    assessedAt: "2026-08-28T08:07:00.000Z"
  });
  expect(result.tier).toBe("red");
  expect(result.signals.map((signal) => signal.code)).toContain("payment-required");
});
```

- [ ] **Step 2: Verify RED in CI**

Expected failure: missing `legitimacy` module.

- [ ] **Step 3: Implement minimal deterministic assessment**

Blocking signals: unverified bundle, payment required, identity document requested at application stage, suspicious contact domain, and unverified employer identity. Warning signals: unknown end employer, repeated reposting of three or more occurrences in 90 days, low-confidence extraction, or absent posting date. Green requires no warning or blocking signal.

- [ ] **Step 4: Add schema and registry entry**

- [ ] **Step 5: Verify targeted tests, schemas, and typecheck**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: add opportunity legitimacy assessment"
```

### Task 3: Signed scoped execution grants

**Files:**
- Create: `test/unit/career-ops-execution-grant.test.ts`
- Create: `src/career-ops/execution-grant.ts`
- Create: `schemas/execution-grant.schema.json`
- Modify: `src/schema.ts`

**Interfaces:**
- Consumes: `LegitimacyTier` from Task 2 and Ed25519 patterns from `src/approval.ts`.
- Produces: `ExecutionGrant`, `ExecutionGrantDraft`, `ExecutionGrantExpectation`, `createExecutionGrant(draft, privateKey)`, `evaluateExecutionGrant(grant, trustedApprovers, expectation)`.

- [ ] **Step 1: Write failing signature and scope tests**

```ts
import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import {
  createExecutionGrant,
  evaluateExecutionGrant
} from "../../src/career-ops/execution-grant.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const grant = createExecutionGrant({
  grantId: "GRANT-2026-SYNTHETIC-001",
  approvedBy: "synthetic-operator",
  keyId: "KEY-SYNTHETIC-001",
  allowedAdapters: ["career-ops-local-fixture"],
  allowedEmployerDomains: ["synthetic.example"],
  allowedOpportunityTypes: ["job"],
  allowedActionTypes: ["submit-ats-application"],
  allowedFields: ["name", "email", "cv"],
  forbiddenFields: ["protected-traits", "identity-document", "payment"],
  minimumFitScore: 4.5,
  allowedLegitimacyTiers: ["green"],
  maxActions: 5,
  maxActionsPerDay: 2,
  validFrom: "2026-08-28T08:00:00.000Z",
  expiresAt: "2026-08-29T08:00:00.000Z",
  approvalText: "Allow bounded synthetic execution for alpha validation."
}, privateKey);

test("accepts an action inside the signed grant scope", () => {
  const result = evaluateExecutionGrant(grant, [{
    approvedBy: "synthetic-operator",
    keyId: "KEY-SYNTHETIC-001",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  }], {
    adapterId: "career-ops-local-fixture",
    employerDomain: "synthetic.example",
    opportunityType: "job",
    actionType: "submit-ats-application",
    requestedFields: ["name", "email", "cv"],
    fitScore: 4.8,
    legitimacyTier: "green",
    totalConfirmedActions: 1,
    confirmedActionsToday: 0,
    evaluatedAt: "2026-08-28T08:30:00.000Z"
  });
  expect(result.allowed).toBe(true);
});

test("rejects a protected field even when other scope matches", () => {
  const result = evaluateExecutionGrant(grant, [{
    approvedBy: "synthetic-operator",
    keyId: "KEY-SYNTHETIC-001",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  }], {
    adapterId: "career-ops-local-fixture",
    employerDomain: "synthetic.example",
    opportunityType: "job",
    actionType: "submit-ats-application",
    requestedFields: ["name", "protected-traits"],
    fitScore: 4.8,
    legitimacyTier: "green",
    totalConfirmedActions: 1,
    confirmedActionsToday: 0,
    evaluatedAt: "2026-08-28T08:30:00.000Z"
  });
  expect(result.allowed).toBe(false);
  expect(result.blockedBy).toBe("forbidden-field-requested");
});
```

- [ ] **Step 2: Verify RED in CI**

- [ ] **Step 3: Implement canonical signing and verification**

Use stable JSON serialisation and SHA-256 before Ed25519 signing. Bind every grant field into the signature. Reject unknown signer, invalid signature, invalid dates, scope mismatch, insufficient fit, disallowed legitimacy, forbidden or non-allowed fields, total exhaustion, and daily exhaustion.

- [ ] **Step 4: Add strict schema and registry entry**

- [ ] **Step 5: Verify targeted tests and all cryptographic failure cases**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: add scoped execution grants"
```

### Task 4: Transactional Outbox and idempotent state machine

**Files:**
- Create: `test/unit/career-ops-outbox.test.ts`
- Create: `src/career-ops/outbox.ts`
- Create: `schemas/outbox-command.schema.json`
- Modify: `src/schema.ts`

**Interfaces:**
- Consumes: verified bundle hash, packet hash, grant ID, and existing action-intent hash conventions.
- Produces: `OutboxCommand`, `createOutboxCommand`, `markOutboxReady`, `reserveOutboxCommand`, `markOutboxExecuting`, `markOutboxSubmitted`, `confirmOutboxCommand`, `failOutboxCommand`, `suppressOutboxCommand`, `deriveOutboxIdempotencyKey`.

- [ ] **Step 1: Write failing state-transition and replay tests**

```ts
import { expect, test } from "vitest";
import {
  confirmOutboxCommand,
  createOutboxCommand,
  markOutboxReady,
  reserveOutboxCommand
} from "../../src/career-ops/outbox.js";

const command = createOutboxCommand({
  runId: "RUN-SYNTHETIC-001",
  opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
  attemptId: "ATT-2026-SYNTHETIC-001",
  adapterId: "career-ops-local-fixture",
  actionType: "submit-ats-application",
  actionIntentHash: "sha256:" + "1".repeat(64),
  verificationBundleHash: "sha256:" + "2".repeat(64),
  packetHash: "sha256:" + "3".repeat(64),
  executionGrantId: "GRANT-2026-SYNTHETIC-001",
  targetDomain: "synthetic.example",
  documentHashes: ["sha256:" + "4".repeat(64)],
  now: new Date("2026-08-28T08:30:00.000Z")
});

test("creates a stable idempotency key for the same action intent", () => {
  const duplicate = createOutboxCommand({
    runId: "RUN-SYNTHETIC-002",
    opportunityId: command.opportunityId,
    attemptId: command.attemptId,
    adapterId: command.adapterId,
    actionType: command.actionType,
    actionIntentHash: command.actionIntentHash,
    verificationBundleHash: command.verificationBundleHash,
    packetHash: command.packetHash,
    executionGrantId: command.executionGrantId,
    targetDomain: command.targetDomain,
    documentHashes: command.documentHashes,
    now: new Date("2026-08-28T08:31:00.000Z")
  });
  expect(duplicate.idempotencyKey).toBe(command.idempotencyKey);
});

test("rejects confirmation before submission has been attempted", () => {
  const ready = markOutboxReady(command, new Date("2026-08-28T08:31:00.000Z"));
  const reserved = reserveOutboxCommand(ready, "worker-1", new Date("2026-08-28T08:32:00.000Z"));
  expect(() => confirmOutboxCommand(reserved, "PRF-SYNTHETIC", new Date())).toThrow(
    "must be submitted_unconfirmed"
  );
});
```

- [ ] **Step 2: Verify RED in CI**

- [ ] **Step 3: Implement minimal transition functions**

Every function validates the current state, returns a new immutable command, updates timestamps, and asserts the schema. `confirmed` and `suppressed` are terminal. Reservation requires a non-empty worker ID. Failure requires a bounded blocker. Confirmation requires a non-empty proof ID.

- [ ] **Step 4: Add strict schema and registry entry**

- [ ] **Step 5: Add replay, terminal-state, and malformed-hash tests**

- [ ] **Step 6: Verify targeted tests, schemas, and typecheck**

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: add transactional application outbox"
```

### Task 5: Execution adapter contract and shipped synthetic adapter

**Files:**
- Create: `test/unit/career-ops-adapter.test.ts`
- Create: `src/career-ops/execution-adapter.ts`
- Create: `src/career-ops/local-fixture-adapter.ts`
- Create: `schemas/execution-adapter-manifest.schema.json`
- Modify: `src/schema.ts`

**Interfaces:**
- Consumes: `ApplicationAttempt`, `OutboxCommand`, `SubmissionObservationDraft`.
- Produces: `ExecutionAdapter`, `ExecutionAdapterManifest`, `SignedExecutionCommand`, `ExecutionObservation`, `ReconciliationResult`, `SHIPPED_CAREER_EXECUTION_ADAPTERS`, `careerOpsLocalFixtureAdapter`.

- [ ] **Step 1: Write failing adapter authority tests**

```ts
import { expect, test } from "vitest";
import {
  getShippedCareerExecutionAdapter,
  listShippedCareerExecutionAdapters
} from "../../src/career-ops/execution-adapter.js";

test("ships only the synthetic fixture adapter in alpha 1", () => {
  expect(listShippedCareerExecutionAdapters()).toEqual(["career-ops-local-fixture"]);
  expect(getShippedCareerExecutionAdapter("official-email")).toBeNull();
});

test("synthetic adapter refuses a non-synthetic profile scope", async () => {
  const adapter = getShippedCareerExecutionAdapter("career-ops-local-fixture");
  expect(adapter).not.toBeNull();
  const inspection = await adapter!.inspect({
    opportunityId: "OPP-GREENHOUSE-SYNTHETIC-001",
    profileScope: "local-private",
    targetDomain: "synthetic.example"
  });
  expect(inspection.allowed).toBe(false);
  expect(inspection.blockedBy).toBe("synthetic-profile-required");
});
```

- [ ] **Step 2: Verify RED in CI**

- [ ] **Step 3: Implement adapter interfaces and registry**

The shipped registry is a compile-time constant. `getShippedCareerExecutionAdapter` returns `null` for unshipped adapters. Manifest schema validation is mandatory.

- [ ] **Step 4: Implement the local fixture adapter**

The adapter accepts only `profileScope: "synthetic"`, `targetDomain: "synthetic.example"`, complete verification, an allowed command, and a synthetic packet. Execution returns a deterministic observation bound to the command. Collection produces a `confirmation-page` submission observation draft suitable for the existing trusted proof flow.

- [ ] **Step 5: Add strict schema and registry entry**

- [ ] **Step 6: Verify tests and typecheck**

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: add career execution adapter contract"
```

### Task 6: End-to-end synthetic verified execution journey

**Files:**
- Create: `test/golden/career-ops-alpha-journey.test.ts`
- Create: `test/red-team/career-ops-execution.test.ts`
- Create: `src/career-ops/demo.ts`
- Modify: `src/types.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes all Task 1 through Task 5 interfaces plus existing `ApplicationPacket`, application lifecycle, approval, and submission-proof APIs.
- Produces: `runCareerOpsAlphaDemo(now?)` and CLI command `demo-career-ops-alpha`.

- [ ] **Step 1: Write the failing golden journey test**

```ts
import { expect, test } from "vitest";
import { runCareerOpsAlphaDemo } from "../../src/career-ops/demo.js";

test("completes the synthetic opportunity from verification to trusted confirmation", async () => {
  const result = await runCareerOpsAlphaDemo(new Date("2026-08-28T09:00:00.000Z"));
  expect(result.verification.status).toBe("verified");
  expect(result.legitimacy.tier).toBe("green");
  expect(result.grantDecision.allowed).toBe(true);
  expect(result.outbox.status).toBe("confirmed");
  expect(result.applicationAttempt.status).toBe("confirmed");
  expect(result.proofEvaluation.status).toBe("confirmed");
});
```

- [ ] **Step 2: Write failing red-team cases**

Cases must prove that execution stops for:

- stale pre-action observation,
- same-source fake corroboration,
- red legitimacy,
- expired grant,
- fit below threshold,
- forbidden protected field,
- non-synthetic profile,
- duplicate idempotency key in active commands,
- confirmation proof bound to the wrong attempt,
- negative confirmation indicator.

- [ ] **Step 3: Verify RED in CI**

- [ ] **Step 4: Implement the deterministic demo**

Generate synthetic Ed25519 approver and collector keys in memory. Create a verified bundle, green legitimacy result, signed grant, claim graph, application packet, application attempt, approval, Outbox command, adapter observation, signed submission proof, confirmed attempt, and confirmed Outbox command. Return redacted records only.

- [ ] **Step 5: Add CLI command**

Add `demo-career-ops-alpha` to `CLI_COMMANDS`, import `runCareerOpsAlphaDemo`, add a dispatcher function, add the switch case, and include the command in help output if help is generated explicitly.

- [ ] **Step 6: Verify the CLI smoke path**

```bash
npm run build
node dist/cli.js demo-career-ops-alpha
```

Expected JSON includes `verification.status: "verified"`, `outbox.status: "confirmed"`, and `applicationAttempt.status: "confirmed"` without private keys or personal data.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: prove verified career execution end to end"
```

### Task 7: Public documentation, attribution, and prerelease metadata

**Files:**
- Create: `docs/inspirations/career-ops.md`
- Create: `docs/adr/ADR-001-production-execution-boundary.md`
- Create: `docs/adr/ADR-002-three-verification-contract.md`
- Create: `docs/adr/ADR-003-transactional-outbox.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `CITATION.cff` only if its version field is intended to track prereleases.

**Interfaces:**
- Documents the public limits and operator contract introduced in Tasks 1 through 6.

- [ ] **Step 1: Add the Career Ops inspiration note**

State that filter-first evaluation, liveness gating, deep company research, contact targeting, follow-up cadence, repost analysis, and funnel learning influenced the design. State explicitly that VocationOS implements these ideas independently and does not copy Career Ops source code.

- [ ] **Step 2: Add ADRs**

Each ADR records context, decision, alternatives rejected, security consequences, migration consequences, and rollback.

- [ ] **Step 3: Update README**

Lead with the new alpha capability, then state the exact limit: alpha 1 executes only through `career-ops-local-fixture` with a synthetic profile. Do not imply production email or ATS submission.

Add the runnable command:

```bash
node dist/cli.js demo-career-ops-alpha
```

- [ ] **Step 4: Update CHANGELOG and version**

Set `package.json` version to `0.7.0-alpha.1`. Add a dated changelog entry listing verification, legitimacy, grants, Outbox, fixture adapter, end-to-end proof, tests, and explicit production limits.

- [ ] **Step 5: Run documentation and brand checks**

```bash
npm run docs:check
npm run brand:scan
npm run citations:check
```

- [ ] **Step 6: Commit**

```bash
git commit -m "docs: prepare VocationOS 0.7 alpha 1"
```

### Task 8: Full verification, review, and prerelease publication

**Files:**
- Modify only files required to repair failures found by the release gate.
- Create: `docs/RELEASE_VALIDATION_0.7.0-alpha.1.md`

**Interfaces:**
- Consumes all prior tasks and produces release evidence.

- [ ] **Step 1: Run the full release gate through GitHub Actions**

```bash
npm run safe:publish-check
```

Required result: exit code 0 on Ubuntu and Windows.

- [ ] **Step 2: Review the complete diff against `next/0.7`**

Check every spec requirement assigned to alpha 1. Confirm no production adapter was accidentally enabled, no real data entered fixtures, every schema is registered, every new command is documented, and public claims match executable behaviour.

- [ ] **Step 3: Request code review**

Perform separate review passes for:

1. spec compliance,
2. cryptographic binding,
3. state-machine correctness,
4. replay and idempotency,
5. privacy and public-fixture hygiene,
6. TypeScript and API design,
7. documentation honesty.

Repair every blocker and major issue with a failing regression test first.

- [ ] **Step 4: Create release validation evidence**

Record commit SHA, CI workflow URLs, operating systems, test counts, schema count, known limits, package tarball digest when available, SBOM digest, and rollback target `v0.6.2`.

- [ ] **Step 5: Merge the feature PR into `next/0.7` only after all required checks pass**

- [ ] **Step 6: Create annotated prerelease tag and GitHub prerelease**

Tag: `v0.7.0-alpha.1`

Title: `VocationOS v0.7.0-alpha.1, Verified Career Execution Kernel`

The release body must state that the only shipped execution adapter is synthetic and that production email and ATS adapters remain future milestones.

- [ ] **Step 7: Preserve the old line visibly**

Confirm that `v0.6.2`, its assets, and `support/0.6.x` remain accessible and unchanged.

---

## Plan self-review

- Spec coverage: alpha 1 requirements in sections 5 through 11, 15, 16, 17, and 18 are mapped to Tasks 1 through 8. Production email, browser sandbox, and real ATS adapters are explicitly deferred to later prerelease plans.
- Placeholder scan: no TBD, TODO, or unspecified implementation steps remain.
- Type consistency: verification, legitimacy, grant, Outbox, adapter, and demo interfaces use the names declared in the file map and task interface sections.
- Scope check: this plan produces one independently testable and publishable product slice. Email and each ATS family require separate implementation plans after this slice passes.
