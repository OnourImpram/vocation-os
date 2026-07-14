import { decideAutoApply, enableAutoApply, engageKillSwitch, rearmAutoApplyAuthorized } from "../auto-apply.js";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  assertExecutableAdapter,
  compiledAdapterCapabilities,
  resolveEffectiveAdapterCapabilities
} from "../adapters/registry.js";
import { sha256, stableStringify } from "../hash.js";
import type { AuthorityOperation } from "../ipc/protocol.js";
import { createSignedCheckpoint, verifyCheckpointChain } from "../security/audit-checkpoint.js";
import type { CredentialStore } from "../security/credential-store.js";
import { applyLegacyImport, planLegacyImport, summarizeLegacyImportPlan } from "../storage/legacy-import.js";
import type { EncryptedEventStore, StoredEvent } from "../storage/encrypted-event-store.js";
import { RuntimeRepository } from "../storage/runtime-repository.js";
import { createEncryptedBackup, inspectEncryptedBackup } from "../storage/encrypted-backup.js";
import { writeOperationJournal, type StorageOperationJournal } from "../storage/operation-journal.js";
import { CREDENTIAL_ACCOUNTS, getOrCreateCredential } from "../security/credential-store.js";
import { createPublicKey } from "node:crypto";
import type { TrustedApprover } from "../approval.js";
import { PACKAGE_ROOT } from "../paths.js";
import { assertSchema } from "../schema.js";
import { validateDocumentAst, type DocumentAst } from "../document-ast.js";
import { validateDocumentAstV2, type DocumentAstV2 } from "../documents/document-ast-v2.js";
import { ArtifactVault, assertArtifactManifest, type ArtifactManifest } from "../storage/artifact-vault.js";
import {
  PRODUCT_DOMAIN_NAMES,
  ProductRepositories,
  type ProductDomainName,
  type VersionedDomainRecord
} from "../storage/product-repositories.js";
import {
  cancelOnboarding,
  completeOnboardingStep,
  createOnboardingSession,
  failOnboarding,
  resumeOnboarding,
  type ActionableOnboardingStep,
  type OnboardingSession,
  type OnboardingStepResultInput,
  type RedactedResultPointer
} from "../onboarding.js";
import {
  assertProfileImportPlan,
  careerTwinFromImportPlan,
  createProfileImportPlan,
  parseProfileArtifact,
  type ProfileImportPlan
} from "../import/profile-import.js";
import { PROFILE_IMPORT_FORMATS, type ProfileImportFormat } from "../import/profile-parser-worker.js";
import { ApplicationTracker } from "../storage/application-tracker.js";
import type { ApplicationAttemptInput } from "../application-lifecycle.js";
import type { SubmissionProof, TrustedCollector } from "../submission-proof.js";
import type {
  ActionLedgerEntry,
  ApplicationPacket,
  ApprovalReference,
  AutomationRiskSignals,
  AutoApplyDecision,
  ClaimGraph,
  HighStakesFlags,
  ReversibilityTag
} from "../types.js";

interface AuthorityBinding {
  requestId: string;
  requestHash: string;
  operation: AuthorityOperation;
  responseHash: string;
}

interface AuthorityEventPayload {
  authority?: AuthorityBinding;
  metadata?: {
    authority?: AuthorityBinding;
  };
  response?: unknown;
  config?: unknown;
}

export interface AuthorityRequest {
  id: string;
  operation: AuthorityOperation;
  payload: unknown;
}

function assertRequestId(requestId: string): void {
  if (!/^REQ-[A-Za-z0-9-]{8,100}$/.test(requestId)) {
    throw new Error("Authority request id is invalid");
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Authority operation payload must be an object");
  }
  return value as Record<string, unknown>;
}

function eventIdForRequest(requestId: string): string {
  return `EVT-CMD-${sha256(requestId).slice("sha256:".length)}`;
}

function checkpointIdForRequest(requestId: string): string {
  return `CHK-${sha256(requestId).slice("sha256:".length)}`;
}

function uuidForRequest(requestId: string): string {
  const hex = sha256(`onboarding:${requestId}`).slice("sha256:".length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function productDomain(value: unknown): ProductDomainName {
  if (typeof value !== "string" || !PRODUCT_DOMAIN_NAMES.includes(value as ProductDomainName)) {
    throw new Error("Product domain is invalid");
  }
  return value as ProductDomainName;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Expected version must be a non-negative safe integer");
  }
  return value as number;
}

function authorityBinding(event: StoredEvent<AuthorityEventPayload>): AuthorityBinding | null {
  return event.payload.authority ?? event.payload.metadata?.authority ?? null;
}

function authorityResponse(event: StoredEvent<AuthorityEventPayload>): unknown {
  if (event.payload.response !== undefined) return event.payload.response;
  if (event.payload.config !== undefined) return event.payload.config;
  throw new Error("Authority event does not contain a replayable response");
}

export class RuntimeAuthority {
  private readonly repository: RuntimeRepository;

  public constructor(
    private readonly store: EncryptedEventStore,
    private readonly credentials: CredentialStore,
    private readonly runtimeRoot: string,
    private readonly artifactVault: ArtifactVault | null = null
  ) {
    this.repository = new RuntimeRepository(store);
  }

  private recordPersistedResponse(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    response: unknown,
    now: Date
  ): void {
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash: sha256(stableStringify(response)),
      completedAt: now.toISOString()
    });
  }

  private authorityMetadata(request: AuthorityRequest, requestHash: string, response: unknown): Record<string, unknown> {
    return {
      authority: {
        requestId: request.id,
        requestHash,
        operation: request.operation,
        responseHash: sha256(stableStringify(response))
      }
    };
  }

  private async saveOnboardingResponse(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    session: OnboardingSession,
    now: Date
  ): Promise<OnboardingSession> {
    await this.repository.saveOnboardingSession({
      session,
      eventId,
      eventType: `${request.operation}-completed`,
      occurredAt: now,
      metadata: this.authorityMetadata(request, requestHash, session)
    });
    this.recordPersistedResponse(request, requestHash, eventId, session, now);
    return session;
  }

  private async findProfileImportPlan(planHash: string): Promise<ProfileImportPlan | null> {
    const events = await this.store.readAll<{ response?: unknown }>();
    for (const event of [...events].reverse()) {
      if (event.eventType !== "profile-import-plan-completed") continue;
      const response = event.payload.response as ProfileImportPlan | undefined;
      if (!response || response.planHash !== planHash) continue;
      assertProfileImportPlan(response);
      return response;
    }
    return null;
  }

  private async replayOrReject(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string
  ): Promise<{ replayed: true; response: unknown } | null> {
    const receipt = this.store.findAuthorityReceipt(request.id);
    if (receipt) {
      if (receipt.requestHash !== requestHash || receipt.operation !== request.operation) {
        throw new Error("Authority request id was reused with different parameters");
      }
      if (!receipt.eventId || receipt.eventId !== eventId) {
        throw new Error("Authority receipt does not reference the deterministic replay event");
      }
      const event = await this.store.readEvent<AuthorityEventPayload>(receipt.eventId);
      if (!event) throw new Error("Authority receipt references a missing event");
      const binding = authorityBinding(event);
      if (
        !binding
        || binding.requestId !== request.id
        || binding.requestHash !== requestHash
        || binding.operation !== request.operation
        || binding.responseHash !== receipt.responseHash
      ) {
        throw new Error("Authority receipt is not bound to its authenticated event");
      }
      const response = authorityResponse(event);
      if (sha256(stableStringify(response)) !== receipt.responseHash) {
        throw new Error("Authority replay response does not match its receipt");
      }
      return { replayed: true, response };
    }

    const committedEvent = await this.store.readEvent<AuthorityEventPayload>(eventId);
    if (!committedEvent) return null;
    const binding = authorityBinding(committedEvent);
    if (!binding || binding.requestId !== request.id || binding.requestHash !== requestHash || binding.operation !== request.operation) {
      throw new Error("Deterministic authority event id is already bound to another request");
    }
    const response = authorityResponse(committedEvent);
    const responseHash = sha256(stableStringify(response));
    if (binding.responseHash !== responseHash) throw new Error("Authority event response binding is invalid");
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: committedEvent.occurredAt
    });
    return { replayed: true, response };
  }

  private async recordCommand(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    response: unknown,
    now: Date
  ): Promise<void> {
    const responseHash = sha256(stableStringify(response));
    await this.store.append({
      eventId,
      aggregateType: "authority-command",
      aggregateId: request.id,
      eventType: `${request.operation}-completed`,
      schemaVersion: 1,
      occurredAt: now,
      payload: {
        authority: {
          requestId: request.id,
          requestHash,
          operation: request.operation,
          responseHash
        },
        response
      }
    });
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: now.toISOString()
    });
  }

  private async recordDecisionCommand(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    response: AutoApplyDecision,
    entry: ActionLedgerEntry,
    now: Date
  ): Promise<void> {
    assertSchema("action-ledger-entry", entry);
    const responseHash = sha256(stableStringify(response));
    await this.store.append({
      eventId,
      aggregateType: "action-ledger",
      aggregateId: entry.actionId,
      eventType: "auto-apply-decision-recorded",
      schemaVersion: 1,
      occurredAt: now,
      payload: {
        authority: {
          requestId: request.id,
          requestHash,
          operation: request.operation,
          responseHash
        },
        entry,
        response
      }
    });
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: now.toISOString()
    });
  }

  private async mutateConfig(
    request: AuthorityRequest,
    requestHash: string,
    eventId: string,
    transform: (current: Awaited<ReturnType<RuntimeRepository["loadAutoApplyConfig"]>>) => Awaited<ReturnType<RuntimeRepository["loadAutoApplyConfig"]>>,
    now: Date
  ): Promise<unknown> {
    const config = transform(await this.repository.loadAutoApplyConfig());
    const responseHash = sha256(stableStringify(config));
    await this.repository.saveAutoApplyConfig({
      config,
      eventId,
      eventType: `${request.operation}-completed`,
      occurredAt: now,
      metadata: {
        authority: {
          requestId: request.id,
          requestHash,
          operation: request.operation,
          responseHash
        }
      }
    });
    this.store.recordAuthorityReceipt({
      requestId: request.id,
      requestHash,
      operation: request.operation,
      eventId,
      responseHash,
      completedAt: now.toISOString()
    });
    return config;
  }

  private async assertOnboardingStepPrerequisites(
    session: OnboardingSession,
    step: ActionableOnboardingStep,
    result: OnboardingStepResultInput
  ): Promise<void> {
    const repositories = new ProductRepositories(this.store);
    if (step === "profile-import") {
      if (session.initializationMode === "profile") {
        if (result.profilePlanHash === undefined) throw new Error("Profile import step requires a plan hash");
        if (!(await this.findProfileImportPlan(result.profilePlanHash))) {
          throw new Error("Profile import step plan hash is not present in authenticated history");
        }
      } else {
        const profiles = await repositories.profiles.list();
        if (!profiles.some((record) => record.value.profileScope === "synthetic")) {
          throw new Error("Demo profile import step requires a persisted synthetic profile");
        }
      }
    }
    if (step === "claim-review") {
      if (session.initializationMode === "profile") {
        if (session.profilePlanHash === null) throw new Error("Profile claim review requires an active plan hash");
        const plan = await this.findProfileImportPlan(session.profilePlanHash);
        if (!plan) throw new Error("Profile claim review plan is missing from authenticated history");
        const profile = await repositories.profiles.get(careerTwinFromImportPlan(plan).twinId);
        if (!profile) throw new Error("Profile claim review requires the approved plan to be applied");
      } else {
        const profiles = await repositories.profiles.list();
        if (!profiles.some((record) => record.value.profileScope === "synthetic")) {
          throw new Error("Demo claim review requires a persisted synthetic profile");
        }
      }
    }
    if (step === "first-discovery" && (await repositories.opportunities.list()).length === 0) {
      throw new Error("First discovery requires a persisted opportunity");
    }
  }

  public async execute(request: AuthorityRequest, now = new Date()): Promise<unknown> {
    assertRequestId(request.id);
    const requestHash = sha256(stableStringify({ operation: request.operation, payload: request.payload }));
    const eventId = eventIdForRequest(request.id);

    if (request.operation === "health") {
      const checkpointStatus = await verifyCheckpointChain(this.store, this.credentials);
      const head = await this.store.chainHead();
      return {
        status: "ok",
        databaseId: await this.store.databaseId(),
        migrations: this.store.migrations(),
        eventCount: head.eventCount,
        checkpointStatus,
        compiledAdapters: compiledAdapterCapabilities()
      };
    }
    if (request.operation === "auto-apply-status") {
      const config = await this.repository.loadAutoApplyConfig();
      return {
        config,
        effectiveAdapters: resolveEffectiveAdapterCapabilities(config.adapterAllowlist)
      };
    }
    if (request.operation === "legacy-import-plan") {
      return summarizeLegacyImportPlan(planLegacyImport(this.runtimeRoot));
    }
    if (request.operation === "checkpoint-verify") {
      return verifyCheckpointChain(this.store, this.credentials);
    }
    if (request.operation === "approver-list") {
      return this.repository.listTrustedApprovers();
    }
    if (request.operation === "collector-list") {
      return this.repository.listTrustedCollectors();
    }
    if (request.operation === "audit-export") {
      await verifyCheckpointChain(this.store, this.credentials);
      return {
        databaseId: await this.store.databaseId(),
        chainHead: await this.store.chainHead(),
        migrations: this.store.migrations(),
        checkpoints: this.store.listSignedCheckpoints(),
        ledgerSummary: await this.repository.summarizeLedger()
      };
    }
    if (request.operation === "artifact-list") {
      return this.repository.listArtifactManifests();
    }
    if (request.operation === "onboarding-status") {
      return this.repository.loadOnboardingSession();
    }
    if (request.operation === "profile-import-plan-get") {
      objectPayload(request.payload);
      const session = await this.repository.loadOnboardingSession();
      if (!session || session.initializationMode !== "profile" || session.profilePlanHash === null) {
        throw new Error("No active profile import plan is bound to onboarding");
      }
      const plan = await this.findProfileImportPlan(session.profilePlanHash);
      if (!plan) throw new Error("The onboarding profile import plan is missing from authenticated history");
      return plan;
    }
    if (request.operation === "domain-get" || request.operation === "domain-list") {
      const payload = objectPayload(request.payload);
      const domain = productDomain(payload["domain"]);
      const repository = new ProductRepositories(this.store).repository(domain);
      const includeArchived = payload["includeArchived"] === true;
      if (request.operation === "domain-list") return repository.list(includeArchived);
      const recordId = requiredString(payload["recordId"], "Domain record id");
      return repository.get(recordId, includeArchived);
    }
    if (request.operation === "tracker-list" || request.operation === "tracker-get") {
      const payload = objectPayload(request.payload);
      const tracker = new ApplicationTracker(new ProductRepositories(this.store));
      if (request.operation === "tracker-list") return tracker.list(payload["includeArchived"] === true);
      return tracker.get(requiredString(payload["attemptId"], "Application attempt id"));
    }

    await verifyCheckpointChain(this.store, this.credentials);
    const replay = await this.replayOrReject(request, requestHash, eventId);
    if (replay) return replay.response;

    if (request.operation === "daemon-stop") {
      objectPayload(request.payload);
      const response = { status: "shutdown-authorized", requestedAt: now.toISOString() };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "auto-apply-kill") {
      const payload = objectPayload(request.payload);
      const reason = typeof payload["reason"] === "string" ? payload["reason"] : "operator kill command";
      return this.mutateConfig(
        request,
        requestHash,
        eventId,
        (config) => engageKillSwitch(config, "authenticated-local-operator", reason, now),
        now
      );
    }
    if (request.operation === "artifact-import") {
      if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
      const payload = objectPayload(request.payload);
      const sourcePath = requiredString(payload["sourcePath"], "Artifact source path");
      if (!path.isAbsolute(sourcePath)) throw new Error("Artifact source path must be absolute");
      const stored = this.artifactVault.storeFile(sourcePath);
      const response = stored.manifest;
      await this.repository.saveArtifactManifest({
        manifest: response,
        eventId,
        occurredAt: now,
        metadata: this.authorityMetadata(request, requestHash, response)
      });
      this.recordPersistedResponse(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "profile-import-plan") {
      if (!this.artifactVault) throw new Error("Artifact vault is unavailable in this authority runtime");
      const payload = objectPayload(request.payload);
      const manifest = payload["manifest"] as ArtifactManifest;
      const format = payload["format"] as ProfileImportFormat;
      assertArtifactManifest(manifest);
      assertSchema("artifact-manifest", manifest);
      if (!PROFILE_IMPORT_FORMATS.includes(format)) throw new Error("Profile import format is invalid");
      const plaintext = this.artifactVault.read(manifest);
      let plan: ProfileImportPlan;
      try {
        plan = createProfileImportPlan(manifest, await parseProfileArtifact(plaintext, format), now);
      } finally {
        plaintext.fill(0);
      }
      await this.recordCommand(request, requestHash, eventId, plan, now);
      return plan;
    }
    if (request.operation === "profile-import-apply") {
      const payload = objectPayload(request.payload);
      const planHash = requiredString(payload["planHash"], "Profile import plan hash");
      const plan = await this.findProfileImportPlan(planHash);
      if (!plan) throw new Error("Approved profile import plan was not found");
      if (plan.planHash !== planHash) throw new Error("Profile import plan hash does not match approval");
      const twin = careerTwinFromImportPlan(plan);
      const profiles = new ProductRepositories(this.store).profiles;
      const existing = await profiles.get(twin.twinId, true);
      if (existing) {
        if (existing.status !== "active" || existing.valueHash !== sha256(stableStringify(twin))) {
          throw new Error("Existing imported profile is not bound to the approved plan");
        }
        await this.recordCommand(request, requestHash, eventId, existing, now);
        return existing;
      }
      const record = await profiles.put({
        value: twin,
        expectedVersion: 0,
        operationId: request.id,
        eventId,
        now,
        authority: { requestId: request.id, requestHash, operation: request.operation }
      });
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (request.operation === "onboarding-start") {
      const payload = objectPayload(request.payload);
      const initializationMode = payload["initializationMode"];
      if (initializationMode !== "demo" && initializationMode !== "profile") {
        throw new Error("Onboarding start requires demo or profile initialization mode");
      }
      const existing = await this.repository.loadOnboardingSession();
      if (existing) {
        if (existing.initializationMode !== initializationMode) {
          throw new Error(`Onboarding mode is locked to ${existing.initializationMode}`);
        }
        await this.recordCommand(request, requestHash, eventId, existing, now);
        return existing;
      }
      const session = createOnboardingSession({
        sessionId: uuidForRequest(request.id),
        createdAt: now.toISOString(),
        initializationMode
      });
      return this.saveOnboardingResponse(request, requestHash, eventId, session, now);
    }
    if (
      request.operation === "onboarding-complete-step"
      || request.operation === "onboarding-fail"
      || request.operation === "onboarding-cancel"
      || request.operation === "onboarding-resume"
    ) {
      const payload = objectPayload(request.payload);
      const current = await this.repository.loadOnboardingSession();
      if (!current) throw new Error("Onboarding has not been started");
      const step = requiredString(payload["step"], "Onboarding step") as ActionableOnboardingStep;
      const expectedVersion = requiredVersion(payload["expectedVersion"]);
      const operationId = uuidForRequest(request.id);
      const occurredAt = now.toISOString();
      let next: OnboardingSession;
      if (request.operation === "onboarding-complete-step") {
        const result = payload["result"] as OnboardingStepResultInput;
        await this.assertOnboardingStepPrerequisites(current, step, result);
        next = completeOnboardingStep(current, { operationId, expectedVersion, step, occurredAt, result });
      } else if (request.operation === "onboarding-resume") {
        next = resumeOnboarding(current, { operationId, expectedVersion, step, occurredAt });
      } else {
        const reasonCode = requiredString(payload["reasonCode"], "Onboarding reason code");
        const resultPointer = requiredString(payload["resultPointer"], "Onboarding result pointer") as RedactedResultPointer;
        const command = { operationId, expectedVersion, step, occurredAt, reasonCode, resultPointer };
        next = request.operation === "onboarding-fail"
          ? failOnboarding(current, command)
          : cancelOnboarding(current, command);
      }
      return this.saveOnboardingResponse(request, requestHash, eventId, next, now);
    }
    if (request.operation === "domain-put") {
      const payload = objectPayload(request.payload);
      const domain = productDomain(payload["domain"]);
      const value = payload["value"];
      const expectedVersion = requiredVersion(payload["expectedVersion"]);
      if (domain === "applications") {
        throw new Error("Application records must use tracker lifecycle operations");
      }
      if (domain === "profiles" && typeof value === "object" && value !== null) {
        const twinId = (value as { twinId?: unknown }).twinId;
        if (typeof twinId === "string" && twinId.startsWith("LOCAL-TWIN-")) {
          throw new Error("Imported local profile identifiers are reserved for profile-import-apply");
        }
      }
      if (domain === "documents") {
        const claimGraph = payload["claimGraph"] as ClaimGraph;
        if (typeof claimGraph !== "object" || claimGraph === null) {
          throw new Error("Document writes require a claim graph");
        }
        assertSchema("claim-graph", claimGraph);
        const documentValue = value as DocumentAst | DocumentAstV2;
        const validation = "schemaVersion" in documentValue && documentValue.schemaVersion === 2
          ? validateDocumentAstV2(documentValue, claimGraph, now)
          : validateDocumentAst(documentValue as DocumentAst, claimGraph, now);
        if (!validation.valid) throw new Error(`Document AST validation failed: ${validation.reasons.join(", ")}`);
      }
      const repository = new ProductRepositories(this.store).repository(domain);
      const record = await repository.put({
        value,
        expectedVersion,
        operationId: request.id,
        eventId,
        now,
        authority: { requestId: request.id, requestHash, operation: request.operation }
      });
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (
      request.operation === "tracker-create"
      || request.operation === "tracker-approve"
      || request.operation === "tracker-submit"
      || request.operation === "tracker-block"
      || request.operation === "tracker-confirm"
    ) {
      const payload = objectPayload(request.payload);
      const tracker = new ApplicationTracker(
        new ProductRepositories(this.store),
        await this.repository.listTrustedApprovers(),
        await this.repository.listTrustedCollectors()
      );
      const context = {
        operationId: request.id,
        eventId,
        authority: { requestId: request.id, requestHash, operation: request.operation },
        now
      };
      let record: VersionedDomainRecord<unknown>;
      if (request.operation === "tracker-create") {
        const input = payload["input"] as Omit<ApplicationAttemptInput, "now">;
        if (typeof input !== "object" || input === null) throw new Error("Tracker create input is required");
        record = await tracker.create(input, context) as VersionedDomainRecord<unknown>;
      } else {
        const attemptId = requiredString(payload["attemptId"], "Application attempt id");
        const expectedVersion = requiredVersion(payload["expectedVersion"]);
        if (request.operation === "tracker-approve") {
          record = await tracker.approve(
            attemptId,
            expectedVersion,
            payload["approval"] as ApprovalReference,
            context
          ) as VersionedDomainRecord<unknown>;
        } else if (request.operation === "tracker-submit") {
          record = await tracker.markSubmitted(attemptId, expectedVersion, context) as VersionedDomainRecord<unknown>;
        } else if (request.operation === "tracker-block") {
          record = await tracker.block(
            attemptId,
            expectedVersion,
            requiredString(payload["blocker"], "Application blocker"),
            context
          ) as VersionedDomainRecord<unknown>;
        } else {
          record = await tracker.confirm(
            attemptId,
            expectedVersion,
            payload["proof"] as SubmissionProof,
            context
          ) as VersionedDomainRecord<unknown>;
        }
      }
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (request.operation === "domain-archive") {
      const payload = objectPayload(request.payload);
      const domain = productDomain(payload["domain"]);
      if (domain === "applications") {
        throw new Error("Application records must use tracker lifecycle operations");
      }
      const recordId = requiredString(payload["recordId"], "Domain record id");
      const expectedVersion = requiredVersion(payload["expectedVersion"]);
      const repository = new ProductRepositories(this.store).repository(domain);
      const current = await repository.get(recordId, true);
      if (current?.status === "archived") {
        if (current.version !== expectedVersion) {
          throw new Error(`Domain version conflict, expected ${expectedVersion}, current ${current.version}`);
        }
        await this.recordCommand(request, requestHash, eventId, current, now);
        return current;
      }
      const record = await repository.archive({
        recordId,
        expectedVersion,
        operationId: request.id,
        eventId,
        now,
        authority: { requestId: request.id, requestHash, operation: request.operation }
      });
      this.recordPersistedResponse(request, requestHash, eventId, record, now);
      return record;
    }
    if (request.operation === "auto-apply-rearm") {
      objectPayload(request.payload);
      return this.mutateConfig(request, requestHash, eventId, rearmAutoApplyAuthorized, now);
    }
    if (request.operation === "auto-apply-enable") {
      const payload = objectPayload(request.payload);
      const mode = payload["mode"];
      if (mode !== "draft-only" && mode !== "auto") throw new Error("Enable mode must be draft-only or auto");
      return this.mutateConfig(request, requestHash, eventId, (config) => enableAutoApply(config, mode), now);
    }
    if (request.operation === "auto-apply-evaluate") {
      const payload = objectPayload(request.payload);
      const packet = payload["packet"] as ApplicationPacket;
      const claimGraph = payload["claimGraph"] as ClaimGraph;
      const reversibilityTag = payload["reversibilityTag"] as ReversibilityTag;
      const adapterId = payload["adapterId"];
      if (typeof packet !== "object" || packet === null || typeof claimGraph !== "object" || claimGraph === null) {
        throw new Error("Auto apply evaluation requires packet and claim graph objects");
      }
      assertSchema("application-packet", packet);
      assertSchema("claim-graph", claimGraph);
      if (typeof adapterId !== "string") throw new Error("Auto apply evaluation requires an adapter id");
      if (!(["R0", "R1", "R2", "R3", "R4"] as const).includes(reversibilityTag)) {
        throw new Error("Auto apply evaluation requires a valid reversibility tag");
      }
      const config = await this.repository.loadAutoApplyConfig();
      const actionHex = sha256(request.id).slice("sha256:".length);
      const actionUuid = `${actionHex.slice(0, 8)}-${actionHex.slice(8, 12)}-${actionHex.slice(12, 16)}-${actionHex.slice(16, 20)}-${actionHex.slice(20, 32)}`;
      const actionId = `A-${now.getUTCFullYear()}-${actionUuid}`;
      const approvalReference = payload["approvalReference"] as ApprovalReference | undefined;
      const riskSignals = payload["riskSignals"] as AutomationRiskSignals | undefined;
      const highStakesFlags = payload["highStakesFlags"] as HighStakesFlags | undefined;
      let decision: AutoApplyDecision;
      try {
        assertExecutableAdapter(adapterId, config.adapterAllowlist, claimGraph.profileScope);
        decision = decideAutoApply({
          config,
          packet,
          claimGraph,
          reversibilityTag,
          adapterId,
          ...(approvalReference ? { approvalReference } : {}),
          trustedApprovers: await this.repository.listTrustedApprovers(),
          ...(riskSignals ? { riskSignals } : {}),
          ...(highStakesFlags ? { highStakesFlags } : {}),
          documentRoot: PACKAGE_ROOT,
          authoritativeLedgerEntries: await this.repository.readLedger(),
          actionId,
          now
        });
      } catch (error) {
        decision = {
          allowed: false,
          blockedBy: "adapter-authority-denied",
          reasons: [error instanceof Error ? error.message : String(error)],
          requiredApprovals: [],
          ledgerActionId: actionId,
          confirmationEvidenceRequired: true
        };
      }
      const entry: ActionLedgerEntry = {
        actionId,
        timestamp: now.toISOString(),
        mode: "/auto-apply-config",
        opportunityId: packet.opportunityId,
        reversibilityTag,
        evidenceGatePassed: decision.allowed || decision.blockedBy === "approval-required",
        approvalRequired: true,
        approvalReceived: approvalReference !== undefined,
        highStakesGatePassed: !highStakesFlags || !Object.values(highStakesFlags).some((value) => value === true),
        result: decision.allowed ? "decision_allowed" : "blocked",
        ...(decision.blockedBy ? { blockedBy: decision.blockedBy } : {})
      };
      await this.recordDecisionCommand(request, requestHash, eventId, decision, entry, now);
      return decision;
    }
    if (request.operation === "legacy-import-apply") {
      const payload = objectPayload(request.payload);
      const planHash = payload["planHash"];
      if (typeof planHash !== "string") throw new Error("Legacy import apply requires a plan hash");
      const plan = planLegacyImport(this.runtimeRoot);
      if (plan.planHash !== planHash) throw new Error("Legacy import plan changed after approval");
      const digest = planHash.slice("sha256:".length);
      const preImportHead = await this.store.chainHead();
      const stateBinding = `${preImportHead.eventCount}-${preImportHead.headHash.slice("sha256:".length)}`;
      const backupPath = path.join(
        this.runtimeRoot,
        "backups",
        `pre-import-${digest}-${stateBinding}.vocationbak`
      );
      const journalPath = path.join(
        this.runtimeRoot,
        "operations",
        `legacy-import-${digest}-${stateBinding}.json`
      );
      const rollbackPassphrase = await getOrCreateCredential(
        this.credentials,
        CREDENTIAL_ACCOUNTS.rollbackBackupPassphrase,
        32
      );
      const journal: StorageOperationJournal = {
        version: 1,
        operationId: `IMPORT-${digest.slice(0, 32)}`,
        operation: "legacy-import",
        phase: "prepared",
        targetPath: this.store.path(),
        rollbackPath: backupPath,
        expectedHash: planHash,
        updatedAt: now.toISOString()
      };
      writeOperationJournal(journalPath, journal);
      if (!existsSync(backupPath)) {
        await createEncryptedBackup(this.store, backupPath, rollbackPassphrase, { now });
      } else {
        const existingBackup = inspectEncryptedBackup(backupPath, rollbackPassphrase);
        if (
          existingBackup.databaseId !== await this.store.databaseId()
          || existingBackup.eventCount !== preImportHead.eventCount
          || existingBackup.eventChainHead !== preImportHead.headHash
        ) {
          throw new Error("Existing rollback backup does not match the current pre-import event state");
        }
      }
      journal.phase = "backup_complete";
      journal.updatedAt = new Date(now.getTime() + 1).toISOString();
      writeOperationJournal(journalPath, journal);
      const importResult = await applyLegacyImport(this.store, plan, planHash, now);
      const response = { ...importResult, rollbackBackupPath: backupPath, journalPath };
      await this.recordCommand(request, requestHash, eventId, response, now);
      journal.phase = "complete";
      journal.updatedAt = new Date(now.getTime() + 2).toISOString();
      writeOperationJournal(journalPath, journal);
      return response;
    }
    if (request.operation === "checkpoint-create") {
      objectPayload(request.payload);
      const response = await createSignedCheckpoint(
        this.store,
        this.credentials,
        now,
        checkpointIdForRequest(request.id)
      );
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "approver-register") {
      const payload = objectPayload(request.payload);
      const approvedBy = payload["approvedBy"];
      const keyId = payload["keyId"];
      const publicKeyPem = payload["publicKeyPem"];
      if (typeof approvedBy !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(approvedBy)) {
        throw new Error("Approver identity is invalid");
      }
      if (typeof keyId !== "string" || !/^KEY-[A-Za-z0-9-]{8,100}$/.test(keyId)) {
        throw new Error("Approver key id is invalid");
      }
      if (typeof publicKeyPem !== "string") throw new Error("Approver public key is required");
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Approver key must be Ed25519");
      const approver: TrustedApprover = { approvedBy, keyId, publicKeyPem };
      const existing = (await this.repository.listTrustedApprovers()).find((candidate) => candidate.keyId === keyId);
      if (existing && stableStringify(existing) !== stableStringify(approver)) {
        throw new Error("Approver key id is already registered with different material");
      }
      const response = { action: "registered" as const, approver };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "approver-revoke") {
      const payload = objectPayload(request.payload);
      const keyId = payload["keyId"];
      if (typeof keyId !== "string" || !/^KEY-[A-Za-z0-9-]{8,100}$/.test(keyId)) {
        throw new Error("Approver key id is invalid");
      }
      const response = { action: "revoked" as const, keyId };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "collector-register") {
      const payload = objectPayload(request.payload);
      const collector = payload as unknown as TrustedCollector;
      assertSchema("trusted-collector", collector);
      const key = createPublicKey(collector.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Collector key must be Ed25519");
      const existing = (await this.repository.listTrustedCollectors())
        .find((candidate) => candidate.keyId === collector.keyId);
      if (existing && stableStringify(existing) !== stableStringify(collector)) {
        throw new Error("Collector key id is already registered with different material");
      }
      const response = { action: "registered" as const, collector };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    if (request.operation === "collector-revoke") {
      const payload = objectPayload(request.payload);
      const keyId = requiredString(payload["keyId"], "Collector key id");
      if (!/^KEY-[A-Z0-9-]{8,100}$/.test(keyId)) throw new Error("Collector key id is invalid");
      const response = { action: "revoked" as const, keyId };
      await this.recordCommand(request, requestHash, eventId, response, now);
      return response;
    }
    throw new Error(`Unsupported authority operation: ${request.operation}`);
  }
}
