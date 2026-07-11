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
    private readonly runtimeRoot: string
  ) {
    this.repository = new RuntimeRepository(store);
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
      if (!receipt.eventId) throw new Error("Authority receipt does not reference a replay event");
      const event = await this.store.readEvent<AuthorityEventPayload>(receipt.eventId);
      if (!event) throw new Error("Authority receipt references a missing event");
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

    await verifyCheckpointChain(this.store, this.credentials);
    const replay = await this.replayOrReject(request, requestHash, eventId);
    if (replay) return replay.response;

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
    throw new Error(`Unsupported authority operation: ${request.operation}`);
  }
}
