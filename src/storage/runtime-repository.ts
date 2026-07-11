import { assertSchema } from "../schema.js";
import { defaultAutoApplyConfig } from "../auto-apply.js";
import type { ActionLedgerEntry, AutoApplyConfig } from "../types.js";
import type { TrustedApprover } from "../approval.js";
import type { EncryptedEventStore, StoredEvent } from "./encrypted-event-store.js";

interface ConfigEventPayload {
  config?: AutoApplyConfig;
  response?: AutoApplyConfig;
  value?: {
    config?: AutoApplyConfig;
  };
}

interface LedgerEventPayload {
  entry?: ActionLedgerEntry;
  value?: {
    entry?: ActionLedgerEntry;
  };
}

interface ApproverEventPayload {
  response?: {
    action?: "registered" | "revoked";
    approver?: TrustedApprover;
    keyId?: string;
  };
}

function configFromEvent(event: StoredEvent<ConfigEventPayload>): AutoApplyConfig | null {
  const config = event.payload.config ?? event.payload.response ?? event.payload.value?.config;
  if (!config) return null;
  assertSchema("auto-apply-config", config);
  return config;
}

function ledgerEntryFromEvent(event: StoredEvent<LedgerEventPayload>): ActionLedgerEntry | null {
  const entry = event.payload.entry ?? event.payload.value?.entry;
  if (!entry) return null;
  assertSchema("action-ledger-entry", entry);
  return entry;
}

export class RuntimeRepository {
  public constructor(private readonly store: EncryptedEventStore) {}

  public async loadAutoApplyConfig(): Promise<AutoApplyConfig> {
    const events = await this.store.readAggregate<ConfigEventPayload>("runtime-config", "auto-apply");
    for (const event of [...events].reverse()) {
      const config = configFromEvent(event);
      if (config) return config;
    }
    return defaultAutoApplyConfig();
  }

  public async saveAutoApplyConfig(input: {
    config: AutoApplyConfig;
    eventId?: string;
    eventType: string;
    occurredAt?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    assertSchema("auto-apply-config", input.config);
    const event = await this.store.append({
      ...(input.eventId ? { eventId: input.eventId } : {}),
      aggregateType: "runtime-config",
      aggregateId: "auto-apply",
      eventType: input.eventType,
      schemaVersion: 1,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      payload: {
        config: input.config,
        ...(input.metadata ? { metadata: input.metadata } : {})
      }
    });
    return event.eventId;
  }

  public async appendLedgerEntry(input: {
    entry: ActionLedgerEntry;
    eventId?: string;
    occurredAt?: Date;
  }): Promise<string> {
    assertSchema("action-ledger-entry", input.entry);
    const existing = await this.readLedger();
    if (existing.some((entry) => entry.actionId === input.entry.actionId)) {
      throw new Error(`Duplicate action id: ${input.entry.actionId}`);
    }
    const event = await this.store.append({
      ...(input.eventId ? { eventId: input.eventId } : {}),
      aggregateType: "action-ledger",
      aggregateId: input.entry.actionId,
      eventType: "action-ledger-entry-recorded",
      schemaVersion: 1,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      payload: { entry: input.entry }
    });
    return event.eventId;
  }

  public async readLedger(): Promise<ActionLedgerEntry[]> {
    const events = (await this.store.readAll<LedgerEventPayload>())
      .filter((event) => event.aggregateType === "action-ledger");
    return events.flatMap((event) => {
      const entry = ledgerEntryFromEvent(event);
      return entry ? [entry] : [];
    });
  }

  public async summarizeLedger(): Promise<Record<string, number>> {
    return (await this.readLedger()).reduce<Record<string, number>>((summary, entry) => {
      summary[entry.result] = (summary[entry.result] ?? 0) + 1;
      if (entry.blockedBy) {
        const key = `blocked:${entry.blockedBy}`;
        summary[key] = (summary[key] ?? 0) + 1;
      }
      return summary;
    }, {});
  }

  public async listTrustedApprovers(): Promise<TrustedApprover[]> {
    const registry = new Map<string, TrustedApprover>();
    const events = (await this.store.readAll<ApproverEventPayload>())
      .filter((event) => event.eventType === "approver-register-completed" || event.eventType === "approver-revoke-completed");
    for (const event of events) {
      const response = event.payload.response;
      if (response?.action === "registered" && response.approver) {
        registry.set(response.approver.keyId, response.approver);
      }
      if (response?.action === "revoked" && response.keyId) registry.delete(response.keyId);
    }
    return [...registry.values()].sort((left, right) => left.keyId.localeCompare(right.keyId));
  }
}
