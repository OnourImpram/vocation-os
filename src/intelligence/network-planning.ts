import {
  assertEvidenceRefs,
  intelligenceAssertion,
  uniqueEvidenceRefs,
  type IntelligenceAssertion,
  type IntelligenceAssertionCode
} from "./assertions.js";

export const NETWORK_PERMISSION_STATES = [
  "explicit-opt-in",
  "existing-professional-relationship",
  "public-inbound",
  "unknown",
  "revoked"
] as const;

export const NETWORK_CHANNELS = ["email", "platform-message", "phone", "in-person"] as const;
export const NETWORK_ACTIONS = ["request-advice", "request-introduction", "share-update", "invite-collaboration"] as const;

export type NetworkPermissionState = (typeof NETWORK_PERMISSION_STATES)[number];
export type NetworkChannel = (typeof NETWORK_CHANNELS)[number];
export type NetworkAction = (typeof NETWORK_ACTIONS)[number];

export interface NetworkTouch {
  touchId: string;
  occurredAt: string;
  evidenceRefs: string[];
}

export interface PermissionBoundedContact {
  contactId: string;
  permission: NetworkPermissionState;
  allowedChannels: NetworkChannel[];
  permissionEvidenceRefs: string[];
  recentTouches: NetworkTouch[];
}

export interface NetworkActionRequest {
  requestId: string;
  contactId: string;
  channel: NetworkChannel;
  action: NetworkAction;
  plannedAt: string;
  evidenceRefs: string[];
}

export interface NetworkPlanningPolicy {
  windowDays: number;
  maxTouchesPerWindow: number;
  minimumSpacingDays: number;
}

export interface NetworkActionDisposition {
  requestId: string;
  contactId: string;
  status: "planned-for-review" | "blocked";
  requiresHumanApproval: true;
  reasonCodes: IntelligenceAssertionCode[];
  evidenceRefs: string[];
  assertions: IntelligenceAssertion[];
}

export interface PermissionBoundedNetworkPlan {
  contactDiscovery: "disabled";
  dispositions: NetworkActionDisposition[];
  plannedRequestIds: string[];
  blockedRequestIds: string[];
  assertions: IntelligenceAssertion[];
}

interface NormalizedTouch {
  occurredAt: number;
  evidenceRefs: string[];
}

function validatePolicy(policy: NetworkPlanningPolicy): void {
  if (!Number.isInteger(policy.windowDays) || policy.windowDays < 1) throw new Error("Network window days must be a positive integer");
  if (!Number.isInteger(policy.maxTouchesPerWindow) || policy.maxTouchesPerWindow < 1) {
    throw new Error("Network max touches per window must be a positive integer");
  }
  if (!Number.isInteger(policy.minimumSpacingDays) || policy.minimumSpacingDays < 0) {
    throw new Error("Network minimum spacing days must be a non-negative integer");
  }
  if (policy.minimumSpacingDays > policy.windowDays) throw new Error("Network spacing cannot exceed the fatigue window");
}

function blockedDisposition(
  request: NetworkActionRequest,
  reasonCodes: IntelligenceAssertionCode[],
  evidenceRefs: string[]
): NetworkActionDisposition {
  return {
    requestId: request.requestId,
    contactId: request.contactId,
    status: "blocked",
    requiresHumanApproval: true,
    reasonCodes,
    evidenceRefs,
    assertions: reasonCodes.map((code) => intelligenceAssertion(code, "policy"))
  };
}

export function planPermissionBoundedNetworkActions(
  contacts: PermissionBoundedContact[],
  requests: NetworkActionRequest[],
  policy: NetworkPlanningPolicy
): PermissionBoundedNetworkPlan {
  validatePolicy(policy);
  const contactIds = contacts.map((contact) => contact.contactId);
  if (new Set(contactIds).size !== contactIds.length) throw new Error("Network contact ids must be unique");
  const requestIds = requests.map((request) => request.requestId);
  if (new Set(requestIds).size !== requestIds.length) throw new Error("Network request ids must be unique");

  const contactIndex = new Map<string, PermissionBoundedContact>();
  const touchHistory = new Map<string, NormalizedTouch[]>();
  for (const contact of contacts) {
    if (!contact.contactId.trim()) throw new Error("Network contact id is required");
    if (new Set(contact.allowedChannels).size !== contact.allowedChannels.length) {
      throw new Error(`Network allowed channels must be unique for ${contact.contactId}`);
    }
    const permissionEvidenceRefs = assertEvidenceRefs(contact.permissionEvidenceRefs, `Network contact ${contact.contactId}`);
    const touchIds = contact.recentTouches.map((touch) => touch.touchId);
    if (new Set(touchIds).size !== touchIds.length) throw new Error(`Network touch ids must be unique for ${contact.contactId}`);
    const normalizedTouches = contact.recentTouches.map((touch) => {
      const occurredAt = Date.parse(touch.occurredAt);
      if (!Number.isFinite(occurredAt)) throw new Error(`Network touch ${touch.touchId} has an invalid timestamp`);
      return {
        occurredAt,
        evidenceRefs: assertEvidenceRefs(touch.evidenceRefs, `Network touch ${touch.touchId}`)
      };
    });
    contactIndex.set(contact.contactId, { ...contact, permissionEvidenceRefs });
    touchHistory.set(contact.contactId, normalizedTouches);
  }

  const normalizedRequests = requests.map((request) => {
    if (!request.requestId.trim() || !request.contactId.trim()) throw new Error("Network request and contact ids are required");
    const plannedAt = Date.parse(request.plannedAt);
    if (!Number.isFinite(plannedAt)) throw new Error(`Network request ${request.requestId} has an invalid timestamp`);
    return {
      request: { ...request, evidenceRefs: assertEvidenceRefs(request.evidenceRefs, `Network request ${request.requestId}`) },
      plannedAt
    };
  }).sort((left, right) => left.plannedAt - right.plannedAt || left.request.requestId.localeCompare(right.request.requestId));

  const dispositions: NetworkActionDisposition[] = [];
  const dayMs = 86_400_000;
  for (const entry of normalizedRequests) {
    const request = entry.request;
    const contact = contactIndex.get(request.contactId);
    if (!contact) {
      dispositions.push(blockedDisposition(request, ["NETWORK_CONTACT_NOT_SUPPLIED"], request.evidenceRefs));
      continue;
    }
    const evidenceRefs = uniqueEvidenceRefs([request.evidenceRefs, contact.permissionEvidenceRefs]);
    if (contact.permission === "unknown" || contact.permission === "revoked") {
      dispositions.push(blockedDisposition(request, ["NETWORK_PERMISSION_BLOCKED"], evidenceRefs));
      continue;
    }
    if (!contact.allowedChannels.includes(request.channel)) {
      dispositions.push(blockedDisposition(request, ["NETWORK_CHANNEL_BLOCKED"], evidenceRefs));
      continue;
    }

    const history = touchHistory.get(contact.contactId) ?? [];
    const windowStart = entry.plannedAt - policy.windowDays * dayMs;
    const relevantTouches = history.filter((touch) => touch.occurredAt >= windowStart && touch.occurredAt <= entry.plannedAt);
    const reasonCodes: IntelligenceAssertionCode[] = [];
    if (relevantTouches.length >= policy.maxTouchesPerWindow) reasonCodes.push("NETWORK_FATIGUE_LIMIT_REACHED");
    const latestTouch = relevantTouches.reduce<number | null>(
      (latest, touch) => latest === null || touch.occurredAt > latest ? touch.occurredAt : latest,
      null
    );
    if (latestTouch !== null && entry.plannedAt - latestTouch < policy.minimumSpacingDays * dayMs) {
      reasonCodes.push("NETWORK_SPACING_REQUIRED");
    }
    const historyEvidence = relevantTouches.flatMap((touch) => touch.evidenceRefs);
    const boundedEvidence = uniqueEvidenceRefs([evidenceRefs, historyEvidence]);
    if (reasonCodes.length > 0) {
      dispositions.push(blockedDisposition(request, reasonCodes, boundedEvidence));
      continue;
    }

    const assertions = [
      intelligenceAssertion("NETWORK_ACTION_PLANNED", "calculation", boundedEvidence),
      intelligenceAssertion("NETWORK_ACTION_REVIEW_REQUIRED", "policy")
    ];
    dispositions.push({
      requestId: request.requestId,
      contactId: request.contactId,
      status: "planned-for-review",
      requiresHumanApproval: true,
      reasonCodes: ["NETWORK_ACTION_PLANNED", "NETWORK_ACTION_REVIEW_REQUIRED"],
      evidenceRefs: boundedEvidence,
      assertions
    });
    history.push({ occurredAt: entry.plannedAt, evidenceRefs: request.evidenceRefs });
    touchHistory.set(contact.contactId, history);
  }

  return {
    contactDiscovery: "disabled",
    dispositions,
    plannedRequestIds: dispositions.filter((entry) => entry.status === "planned-for-review").map((entry) => entry.requestId),
    blockedRequestIds: dispositions.filter((entry) => entry.status === "blocked").map((entry) => entry.requestId),
    assertions: dispositions.flatMap((entry) => entry.assertions)
  };
}
