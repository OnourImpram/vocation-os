import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchApp } from "../src/app.js";
import {
  WORKBENCH_ROUTES,
  createLoopbackClient,
  createWorkbenchViewModel,
  routeFromPath,
  validateLoopbackOrigin
} from "../src/index.js";

const TOKEN = "session-token-0123456789abcdef0123456789";
const CSRF = "csrf-token-0123456789abcdef012345678901";

describe("workbench contracts", () => {
  it("publishes the complete route surface", () => {
    expect(WORKBENCH_ROUTES.map((route) => route.title)).toEqual([
      "Today",
      "Discovery",
      "Review",
      "Twin",
      "Documents",
      "Pipeline",
      "Evidence",
      "Approvals",
      "Audit",
      "Credentials",
      "Interview",
      "Offers",
      "Settings"
    ]);
    expect(createWorkbenchViewModel({ route: "today", state: "ready", data: {} })
      .navigation.filter((item) => item.active)).toHaveLength(1);
  });

  it("rejects non-loopback or credential-bearing origins", () => {
    expect(() => validateLoopbackOrigin("https://example.com:9443/"))
      .toThrow("explicit loopback host");
    expect(() => validateLoopbackOrigin("http://user:pass@127.0.0.1:9443/"))
      .toThrow("must not contain credentials");
  });

  it("normalizes query, fragment, and long trailing slash input in linear time", () => {
    const pathname = `/today${"/".repeat(250_000)}?view=review#focus`;
    expect(routeFromPath(pathname)?.id).toBe("today");
    expect(routeFromPath("/discovery/#queue")?.id).toBe("discovery");
  });

  it("uses bearer, CSRF, and capability bindings without ambient credentials", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const client = createLoopbackClient({
      origin: "http://127.0.0.1:43117/",
      sessionToken: TOKEN,
      fetch: fetcher
    });

    await expect(client.command("/api/pipeline/review", { id: "ITEM-1" }, {
      csrfToken: CSRF,
      capability: "pipeline.review",
      approvalId: "APPROVAL-1"
    })).resolves.toEqual({ ok: true });

    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "X-Vocation-CSRF": CSRF,
      "X-Vocation-Capability": "pipeline.review",
      "X-Vocation-Approval": "APPROVAL-1"
    });
  });

  it("server-renders the real React navigation surface for all routes", () => {
    const client = {
      origin: "http://127.0.0.1:43117",
      read: async <T,>() => ({}) as T,
      command: async <T,>() => ({}) as T
    };
    const markup = renderToStaticMarkup(createElement(WorkbenchApp, {
      client,
      csrfToken: CSRF
    }));
    for (const route of WORKBENCH_ROUTES) expect(markup).toContain(route.title);
    expect(markup).toContain("Local workbench");
  });
});
