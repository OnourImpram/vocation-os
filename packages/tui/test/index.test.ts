import { createElement } from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { VocationTuiApp } from "../src/app.js";
import {
  createQueueActions,
  createQueueViewModel,
  reduceTuiKeyboardState,
  renderQueueTextFallback,
  startInkTui,
  type DaemonQueueClient,
  type InkRuntime,
  type QueueItem
} from "../src/index.js";

const ITEMS: readonly QueueItem[] = [{
  attemptId: "ATTEMPT-1",
  opportunityId: "OPPORTUNITY-1",
  title: "AI Safety Researcher",
  organization: "Example Lab",
  status: "approved",
  priority: "high",
  updatedAt: "2026-07-14T10:00:00.000Z",
  version: 3,
  blocker: null
}, {
  attemptId: "ATTEMPT-2",
  opportunityId: "OPPORTUNITY-2",
  title: "Clinical Product Lead",
  organization: "Health Systems",
  status: "confirmed",
  priority: "normal",
  updatedAt: "2026-07-13T10:00:00.000Z",
  version: 5,
  blocker: null
}];

describe("TUI queue view models", () => {
  it("filters queue rows without mutating daemon data", () => {
    const model = createQueueViewModel(ITEMS, { query: "example", attentionOnly: true });

    expect(model.rows.map((row) => row.id)).toEqual(["ATTEMPT-1"]);
    expect(model.summary.total).toBe(2);
    expect(ITEMS[0]?.status).toBe("approved");
  });

  it("does not expose application submission from the review-only TUI", () => {
    const actions = createQueueActions(ITEMS[0] ?? (() => { throw new Error("fixture missing"); })());
    expect(actions.map((action) => action.id)).toEqual(["inspect", "mark-blocked"]);
    expect(actions.some((action) => action.command?.kind.includes("submission"))).toBe(false);
  });

  it("starts through an injected Ink-compatible runtime", () => {
    const runtime: InkRuntime<string, { node: string }> = {
      createElement: (component, props) => component(props),
      render: (node) => ({ node })
    };
    const daemon: DaemonQueueClient = {
      queryQueue: async () => [],
      executeQueueCommand: async () => ({ accepted: true, requestId: "REQ", message: "ok" })
    };

    const instance = startInkTui(runtime, () => "ink-node", { daemon, initialFilters: {} });
    expect(instance).toEqual({ node: "ink-node" });
  });

  it("supports keyboard navigation and a narrow terminal text view", () => {
    expect(reduceTuiKeyboardState(
      { selectedIndex: 0, actionIndex: 0 },
      "down",
      2,
      2
    )).toEqual({ selectedIndex: 1, actionIndex: 0 });

    const item = {
      ...(ITEMS[0] ?? (() => { throw new Error("fixture missing"); })()),
      summary: "Evidence grounded role review",
      evidence: [{ id: "E-1", label: "Posting live", status: "verified" as const, source: "provider:example" }]
    };
    const model = createQueueViewModel([item], {}, item.attemptId);
    const text = renderQueueTextFallback(model, item);
    expect(text).toContain("Detail");
    expect(text).toContain("Evidence");
    expect(text).toContain("Actions");
    expect(text).toContain("Posting live");
  });

  it("renders the real Ink queue, detail, evidence, and action surface", () => {
    const daemon: DaemonQueueClient = {
      queryQueue: async () => ITEMS,
      executeQueueCommand: async () => ({ accepted: true, requestId: "REQ", message: "ok" })
    };
    const output = renderToString(createElement(VocationTuiApp, { daemon, initialFilters: {} }));
    expect(output).toContain("Queue");
    expect(output).toContain("Detail");
    expect(output).toContain("Evidence");
    expect(output).toContain("Actions");
  });

  it("exposes discovery review actions only as daemon proposals", () => {
    const item: QueueItem = {
      queueKind: "discovery",
      attemptId: "OPP-REVIEW-1",
      opportunityId: "OPP-REVIEW-1",
      title: "AI Governance Lead",
      organization: "Evidence Systems",
      status: "needs_review",
      priority: "high",
      updatedAt: "2026-07-14T10:00:00.000Z",
      version: 2,
      blocker: null,
      providerId: "greenhouse",
      liveness: "live",
      duplicateStatus: "review",
      taxonomyConfidence: 0.74,
      truthStatus: "actionable",
      campaignId: null
    };
    const actions = createQueueActions(item);
    expect(actions.map((action) => action.id)).toEqual([
      "inspect",
      "accept-review",
      "reject-review",
      "merge-proposal",
      "keep-separate",
      "snooze",
      "refresh-evidence",
      "build-assurance"
    ]);
    expect(actions.every((action) => action.command === null || action.command.kind.startsWith("discovery."))).toBe(true);
  });
});
