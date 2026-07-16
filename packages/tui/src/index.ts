export const QUEUE_STATUSES = [
  "prepared",
  "approved",
  "submitted_unconfirmed",
  "confirmed",
  "blocked",
  "ready",
  "needs_review"
] as const;

export const QUEUE_KINDS = ["applications", "discovery"] as const;
export const QUEUE_PRIORITIES = ["critical", "high", "normal", "low"] as const;
export const QUEUE_SORTS = ["updated-desc", "updated-asc", "priority-desc"] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];
export type QueueKind = (typeof QUEUE_KINDS)[number];
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];
export type QueueSort = (typeof QUEUE_SORTS)[number];

export interface QueueEvidence {
  id: string;
  label: string;
  status: "verified" | "operator-supplied" | "stale" | "missing";
  source: string | null;
}

export interface QueueItem {
  queueKind?: QueueKind;
  attemptId: string;
  opportunityId: string;
  title: string;
  organization: string;
  status: QueueStatus;
  priority: QueuePriority;
  updatedAt: string;
  version: number;
  blocker: string | null;
  summary?: string | null;
  evidence?: readonly QueueEvidence[];
  providerId?: string | null;
  liveness?: string | null;
  duplicateStatus?: string | null;
  taxonomyConfidence?: number | null;
  truthStatus?: string | null;
  campaignId?: string | null;
}

export interface QueueFilters {
  queueKinds?: readonly QueueKind[];
  statuses?: readonly QueueStatus[];
  query?: string;
  attentionOnly?: boolean;
  sort?: QueueSort;
  providers?: readonly string[];
  liveness?: readonly string[];
  duplicateStatuses?: readonly string[];
  minimumTaxonomyConfidence?: number;
  truthStatuses?: readonly string[];
  campaignIds?: readonly string[];
}

export interface DaemonQueueQuery {
  queueKinds: readonly QueueKind[];
  statuses: readonly QueueStatus[];
  query: string | null;
  attentionOnly: boolean;
  providers: readonly string[];
  liveness: readonly string[];
  duplicateStatuses: readonly string[];
  minimumTaxonomyConfidence: number | null;
  truthStatuses: readonly string[];
  campaignIds: readonly string[];
}

export type DaemonQueueCommandKind =
  | "approval.request"
  | "attempt.block"
  | "attempt.rearm"
  | "confirmation.review"
  | "discovery.accept-review"
  | "discovery.reject-review"
  | "discovery.merge-proposal"
  | "discovery.keep-separate"
  | "discovery.snooze"
  | "discovery.refresh-evidence"
  | "discovery.build-assurance";

export interface DaemonQueueCommand {
  kind: DaemonQueueCommandKind;
  attemptId: string;
  opportunityId: string;
  expectedVersion: number;
}

export interface QueueCommandResult {
  accepted: boolean;
  requestId: string;
  message: string;
}

export interface DaemonQueueClient {
  queryQueue(query: DaemonQueueQuery): Promise<readonly QueueItem[]>;
  executeQueueCommand(command: DaemonQueueCommand): Promise<QueueCommandResult>;
}

export type QueueActionId =
  | "inspect"
  | "request-approval"
  | "mark-blocked"
  | "rearm"
  | "review-confirmation"
  | "accept-review"
  | "reject-review"
  | "merge-proposal"
  | "keep-separate"
  | "snooze"
  | "refresh-evidence"
  | "build-assurance";

export interface QueueActionViewModel {
  id: QueueActionId;
  label: string;
  tone: "neutral" | "primary" | "danger";
  requiresScopedApproval: boolean;
  command: DaemonQueueCommand | null;
}

export interface QueueRowViewModel {
  id: string;
  primaryText: string;
  secondaryText: string;
  status: QueueStatus;
  statusLabel: string;
  statusTone: "neutral" | "attention" | "success" | "danger";
  selected: boolean;
  actions: readonly QueueActionViewModel[];
}

export interface QueueSummaryViewModel {
  total: number;
  visible: number;
  byStatus: Readonly<Record<QueueStatus, number>>;
}

export interface QueueViewModel {
  rows: readonly QueueRowViewModel[];
  selectedId: string | null;
  emptyMessage: string | null;
  summary: QueueSummaryViewModel;
}

const PRIORITY_ORDER: Readonly<Record<QueuePriority, number>> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
};

const STATUS_LABELS: Readonly<Record<QueueStatus, string>> = {
  prepared: "Prepared",
  approved: "Approved",
  submitted_unconfirmed: "Awaiting evidence",
  confirmed: "Confirmed",
  blocked: "Blocked",
  ready: "Ready",
  needs_review: "Needs review"
};

function statusTone(status: QueueStatus): QueueRowViewModel["statusTone"] {
  if (status === "confirmed" || status === "ready") return "success";
  if (status === "blocked") return "danger";
  if (status === "approved" || status === "submitted_unconfirmed") return "attention";
  return "neutral";
}

function isAttentionRequired(item: QueueItem): boolean {
  return item.status !== "confirmed" && item.status !== "ready";
}

export function toDaemonQueueQuery(filters: QueueFilters = {}): DaemonQueueQuery {
  const query = filters.query?.trim() ?? "";
  const minimumTaxonomyConfidence = filters.minimumTaxonomyConfidence ?? null;
  if (minimumTaxonomyConfidence !== null && (
    !Number.isFinite(minimumTaxonomyConfidence)
    || minimumTaxonomyConfidence < 0
    || minimumTaxonomyConfidence > 1
  )) throw new Error("Minimum taxonomy confidence must be between zero and one");
  return Object.freeze({
    queueKinds: Object.freeze([...(filters.queueKinds ?? ["applications"])]),
    statuses: Object.freeze([...(filters.statuses ?? QUEUE_STATUSES)]),
    query: query.length > 0 ? query : null,
    attentionOnly: filters.attentionOnly ?? false,
    providers: Object.freeze([...(filters.providers ?? [])]),
    liveness: Object.freeze([...(filters.liveness ?? [])]),
    duplicateStatuses: Object.freeze([...(filters.duplicateStatuses ?? [])]),
    minimumTaxonomyConfidence,
    truthStatuses: Object.freeze([...(filters.truthStatuses ?? [])]),
    campaignIds: Object.freeze([...(filters.campaignIds ?? [])])
  });
}

export function filterQueue(items: readonly QueueItem[], filters: QueueFilters = {}): QueueItem[] {
  const statuses = new Set(filters.statuses ?? QUEUE_STATUSES);
  const queueKinds = new Set(filters.queueKinds ?? ["applications"]);
  const providers = new Set(filters.providers ?? []);
  const liveness = new Set(filters.liveness ?? []);
  const duplicateStatuses = new Set(filters.duplicateStatuses ?? []);
  const truthStatuses = new Set(filters.truthStatuses ?? []);
  const campaignIds = new Set(filters.campaignIds ?? []);
  const query = filters.query?.trim().toLocaleLowerCase() ?? "";
  const sort = filters.sort ?? "updated-desc";

  const filtered = items.filter((item) => {
    if (!queueKinds.has(item.queueKind ?? "applications")) return false;
    if (!statuses.has(item.status)) return false;
    if (providers.size > 0 && (!item.providerId || !providers.has(item.providerId))) return false;
    if (liveness.size > 0 && (!item.liveness || !liveness.has(item.liveness))) return false;
    if (duplicateStatuses.size > 0 && (!item.duplicateStatus || !duplicateStatuses.has(item.duplicateStatus))) return false;
    if (truthStatuses.size > 0 && (!item.truthStatus || !truthStatuses.has(item.truthStatus))) return false;
    if (campaignIds.size > 0 && (!item.campaignId || !campaignIds.has(item.campaignId))) return false;
    if (
      filters.minimumTaxonomyConfidence !== undefined
      && (item.taxonomyConfidence === null
        || item.taxonomyConfidence === undefined
        || item.taxonomyConfidence < filters.minimumTaxonomyConfidence)
    ) return false;
    if (filters.attentionOnly && !isAttentionRequired(item)) return false;
    if (query.length === 0) return true;
    return [item.title, item.organization, item.opportunityId, item.attemptId, item.providerId ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(query));
  });

  return filtered.sort((left, right) => {
    if (sort === "priority-desc") {
      const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
      if (priority !== 0) return priority;
    }
    const timestamp = left.updatedAt.localeCompare(right.updatedAt);
    return sort === "updated-asc" ? timestamp : -timestamp;
  });
}

function command(item: QueueItem, kind: DaemonQueueCommandKind): DaemonQueueCommand {
  return Object.freeze({
    kind,
    attemptId: item.attemptId,
    opportunityId: item.opportunityId,
    expectedVersion: item.version
  });
}

export function createQueueActions(item: QueueItem): readonly QueueActionViewModel[] {
  const actions: QueueActionViewModel[] = [{
    id: "inspect",
    label: "Inspect",
    tone: "neutral",
    requiresScopedApproval: false,
    command: null
  }];

  if (item.queueKind === "discovery") {
    const discoveryActions: Array<{
      id: QueueActionId;
      label: string;
      tone: QueueActionViewModel["tone"];
      kind: DaemonQueueCommandKind;
    }> = [{
      id: "accept-review", label: "Propose accept", tone: "primary", kind: "discovery.accept-review"
    }, {
      id: "reject-review", label: "Propose reject", tone: "danger", kind: "discovery.reject-review"
    }, {
      id: "merge-proposal", label: "Propose merge", tone: "primary", kind: "discovery.merge-proposal"
    }, {
      id: "keep-separate", label: "Keep separate", tone: "neutral", kind: "discovery.keep-separate"
    }, {
      id: "snooze", label: "Snooze review", tone: "neutral", kind: "discovery.snooze"
    }, {
      id: "refresh-evidence", label: "Refresh evidence", tone: "primary", kind: "discovery.refresh-evidence"
    }, {
      id: "build-assurance", label: "Build assurance case", tone: "primary", kind: "discovery.build-assurance"
    }];
    actions.push(...discoveryActions.map((action) => ({
      id: action.id,
      label: action.label,
      tone: action.tone,
      requiresScopedApproval: false,
      command: command(item, action.kind)
    })));
    return Object.freeze(actions.map((action) => Object.freeze(action)));
  }

  if (item.status === "prepared") {
    actions.push({
      id: "request-approval",
      label: "Request approval",
      tone: "primary",
      requiresScopedApproval: false,
      command: command(item, "approval.request")
    });
  }
  if (item.status === "submitted_unconfirmed") {
    actions.push({
      id: "review-confirmation",
      label: "Review evidence",
      tone: "primary",
      requiresScopedApproval: false,
      command: command(item, "confirmation.review")
    });
  }
  if (item.status === "blocked") {
    actions.push({
      id: "rearm",
      label: "Request rearm",
      tone: "primary",
      requiresScopedApproval: true,
      command: command(item, "attempt.rearm")
    });
  }
  if (item.status !== "confirmed" && item.status !== "blocked") {
    actions.push({
      id: "mark-blocked",
      label: "Mark blocked",
      tone: "danger",
      requiresScopedApproval: false,
      command: command(item, "attempt.block")
    });
  }

  return Object.freeze(actions.map((action) => Object.freeze(action)));
}

function statusCounts(items: readonly QueueItem[]): Readonly<Record<QueueStatus, number>> {
  const counts = Object.fromEntries(QUEUE_STATUSES.map((status) => [status, 0])) as Record<QueueStatus, number>;
  for (const item of items) counts[item.status] += 1;
  return Object.freeze(counts);
}

export function createQueueViewModel(
  items: readonly QueueItem[],
  filters: QueueFilters = {},
  requestedSelectedId: string | null = null
): QueueViewModel {
  const visible = filterQueue(items, filters);
  const selectedId = visible.some((item) => item.attemptId === requestedSelectedId)
    ? requestedSelectedId
    : (visible[0]?.attemptId ?? null);
  const rows = visible.map((item): QueueRowViewModel => Object.freeze({
    id: item.attemptId,
    primaryText: item.title,
    secondaryText: item.organization,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    statusTone: statusTone(item.status),
    selected: item.attemptId === selectedId,
    actions: createQueueActions(item)
  }));

  return Object.freeze({
    rows: Object.freeze(rows),
    selectedId,
    emptyMessage: rows.length === 0 ? "No queue items match the active filters." : null,
    summary: Object.freeze({
      total: items.length,
      visible: rows.length,
      byStatus: statusCounts(items)
    })
  });
}

export async function loadQueueViewModel(
  client: DaemonQueueClient,
  filters: QueueFilters = {},
  selectedId: string | null = null
): Promise<QueueViewModel> {
  const items = await client.queryQueue(toDaemonQueueQuery(filters));
  return createQueueViewModel(items, filters, selectedId);
}

export function dispatchQueueAction(
  client: DaemonQueueClient,
  action: QueueActionViewModel
): Promise<QueueCommandResult> {
  if (!action.command) throw new Error(`Queue action ${action.id} is local and cannot be dispatched`);
  return client.executeQueueCommand(action.command);
}

export interface TuiAppProps {
  daemon: DaemonQueueClient;
  initialFilters: QueueFilters;
}

export interface TuiKeyboardState {
  selectedIndex: number;
  actionIndex: number;
}

export type TuiKeyboardEvent = "up" | "down" | "left" | "right" | "home" | "end";

function wrapIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

export function reduceTuiKeyboardState(
  state: TuiKeyboardState,
  event: TuiKeyboardEvent,
  rowCount: number,
  actionCount: number
): TuiKeyboardState {
  if (rowCount <= 0) return Object.freeze({ selectedIndex: 0, actionIndex: 0 });
  if (event === "up") {
    return Object.freeze({ selectedIndex: wrapIndex(state.selectedIndex - 1, rowCount), actionIndex: 0 });
  }
  if (event === "down") {
    return Object.freeze({ selectedIndex: wrapIndex(state.selectedIndex + 1, rowCount), actionIndex: 0 });
  }
  if (event === "home") return Object.freeze({ selectedIndex: 0, actionIndex: 0 });
  if (event === "end") return Object.freeze({ selectedIndex: rowCount - 1, actionIndex: 0 });
  if (event === "left") {
    return Object.freeze({
      selectedIndex: state.selectedIndex,
      actionIndex: wrapIndex(state.actionIndex - 1, actionCount)
    });
  }
  return Object.freeze({
    selectedIndex: state.selectedIndex,
    actionIndex: wrapIndex(state.actionIndex + 1, actionCount)
  });
}

export function renderQueueTextFallback(
  viewModel: QueueViewModel,
  selectedItem: QueueItem | null,
  selectedActionIndex = 0
): string {
  const lines = [
    `VocationOS Queue ${viewModel.summary.visible}/${viewModel.summary.total}`,
    ...viewModel.rows.map((row) => `${row.selected ? ">" : " "} ${row.primaryText} | ${row.secondaryText} | ${row.statusLabel}`)
  ];
  if (!selectedItem) {
    lines.push("", viewModel.emptyMessage ?? "No selected queue item.");
    return lines.join("\n");
  }
  const selectedRow = viewModel.rows.find((row) => row.id === selectedItem.attemptId);
  lines.push(
    "",
    "Detail",
    `${selectedItem.title} at ${selectedItem.organization}`,
    selectedItem.summary ?? `Opportunity ${selectedItem.opportunityId}`,
    `Status: ${selectedRow?.statusLabel ?? selectedItem.status}`,
    `Queue: ${selectedItem.queueKind ?? "applications"}`,
    `Updated: ${selectedItem.updatedAt}`
  );
  if (selectedItem.providerId) lines.push(`Provider: ${selectedItem.providerId}`);
  if (selectedItem.liveness) lines.push(`Liveness: ${selectedItem.liveness}`);
  if (selectedItem.truthStatus) lines.push(`Truth: ${selectedItem.truthStatus}`);
  if (selectedItem.duplicateStatus) lines.push(`Dedupe: ${selectedItem.duplicateStatus}`);
  if (selectedItem.blocker) lines.push(`Blocker: ${selectedItem.blocker}`);
  lines.push("", "Evidence");
  const evidence = selectedItem.evidence ?? [];
  if (evidence.length === 0) lines.push("No evidence attached.");
  else lines.push(...evidence.map((item) => `${item.status === "verified" ? "[x]" : "[ ]"} ${item.label} | ${item.status}`));
  lines.push("", "Actions");
  if (!selectedRow || selectedRow.actions.length === 0) lines.push("No actions available.");
  else lines.push(...selectedRow.actions.map((action, index) => `${index === selectedActionIndex ? ">" : " "} ${action.label}`));
  return lines.join("\n");
}

export type InkCompatibleComponent<Props extends object, Node> = (props: Props) => Node;

export interface InkRuntime<Node, Instance> {
  createElement<Props extends object>(component: InkCompatibleComponent<Props, Node>, props: Props): Node;
  render(node: Node): Instance;
}

export function startInkTui<Props extends TuiAppProps, Node, Instance>(
  runtime: InkRuntime<Node, Instance>,
  component: InkCompatibleComponent<Props, Node>,
  props: Props
): Instance {
  return runtime.render(runtime.createElement(component, props));
}
