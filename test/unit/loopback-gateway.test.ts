import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startLoopbackGateway, type LoopbackGatewayHandle } from "../../src/workbench/index.js";

const openGateways: LoopbackGatewayHandle[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(openGateways.splice(0).map((gateway) => gateway.close()));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function gateway() {
  const authority = { request: vi.fn(async (operation: string, payload: unknown) => ({ operation, payload })) };
  const handle = await startLoopbackGateway({ authority });
  openGateways.push(handle);
  return { authority, handle };
}

describe("loopback workbench gateway", () => {
  it("binds only to the explicit loopback origin and requires authentication", async () => {
    const { handle } = await gateway();
    expect(new URL(handle.origin).hostname).toBe("127.0.0.1");
    const response = await fetch(`${handle.origin}/api/health`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "authentication-required" });
  });

  it("maps read routes to bounded daemon operations", async () => {
    const { authority, handle } = await gateway();
    const response = await fetch(`${handle.origin}/api/opportunities`, {
      headers: { Authorization: `Bearer ${handle.sessionToken}` }
    });
    expect(response.status).toBe(200);
    expect(authority.request).toHaveBeenCalledWith(
      "domain-list",
      { domain: "opportunities" },
      { requestId: expect.stringMatching(/^REQ-WEB-/) }
    );
  });

  it("assembles workbench views exclusively through bounded daemon reads", async () => {
    const authority = {
      request: vi.fn(async (operation: string) => {
        if (operation === "domain-list") return [];
        if (operation === "tracker-list") return [];
        if (operation === "approver-list") return [];
        if (operation === "health") return { status: "healthy" };
        return {};
      })
    };
    const handle = await startLoopbackGateway({ authority });
    openGateways.push(handle);
    const response = await fetch(`${handle.origin}/api/workbench/today`, {
      headers: { Authorization: `Bearer ${handle.sessionToken}` }
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { summary: string; metrics: unknown[] };
    expect(payload.summary).toContain("operator authorization");
    expect(payload.metrics).toHaveLength(3);
    expect(authority.request.mock.calls.map(([operation]) => operation)).toEqual(expect.arrayContaining([
      "domain-list",
      "tracker-list",
      "approver-list",
      "health"
    ]));
  });

  it("requires origin, CSRF, and capability bindings for commands", async () => {
    const { authority, handle } = await gateway();
    const headers = {
      Authorization: `Bearer ${handle.sessionToken}`,
      "Content-Type": "application/json"
    };
    const denied = await fetch(`${handle.origin}/api/safety/kill`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "operator request" })
    });
    expect(denied.status).toBe(403);
    expect(authority.request).not.toHaveBeenCalled();

    const accepted = await fetch(`${handle.origin}/api/safety/kill`, {
      method: "POST",
      headers: {
        ...headers,
        Origin: handle.origin,
        "X-Vocation-CSRF": handle.csrfToken,
        "X-Vocation-Capability": "safety.kill"
      },
      body: JSON.stringify({ reason: "operator request" })
    });
    expect(accepted.status).toBe(200);
    expect(authority.request).toHaveBeenCalledWith(
      "auto-apply-kill",
      { reason: "operator request" },
      { requestId: expect.stringMatching(/^REQ-WEB-/) }
    );
  });

  it("rejects oversized command bodies before daemon dispatch", async () => {
    const authority = { request: vi.fn(async () => ({})) };
    const handle = await startLoopbackGateway({ authority, maxBodyBytes: 32 });
    openGateways.push(handle);
    const response = await fetch(`${handle.origin}/api/tracker/block`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.sessionToken}`,
        Origin: handle.origin,
        "Content-Type": "application/json",
        "X-Vocation-CSRF": handle.csrfToken,
        "X-Vocation-Capability": "pipeline.update"
      },
      body: JSON.stringify({ reason: "x".repeat(100) })
    });
    expect(response.status).toBe(413);
    expect(authority.request).not.toHaveBeenCalled();
  });

  it("serves the production workbench only through a random launch session", async () => {
    const staticRoot = mkdtempSync(path.join(tmpdir(), "vocation-workbench-"));
    temporaryRoots.push(staticRoot);
    writeFileSync(path.join(staticRoot, "index.html"), [
      "<html><body>",
      '<script id="vocation-workbench-bootstrap" type="application/json">',
      '{"origin": "self", "sessionToken": "runtime-injected-session-token-placeholder-0001",',
      '"csrfToken": "runtime-injected-csrf-token-placeholder-000001"}',
      "</script></body></html>"
    ].join(""));
    const authority = { request: vi.fn(async () => ({})) };
    const handle = await startLoopbackGateway({ authority, staticRoot });
    openGateways.push(handle);
    expect(handle.workbenchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/launch\//);

    const denied = await fetch(`${handle.origin}/today`);
    expect(denied.status).toBe(401);

    const launched = await fetch(handle.workbenchUrl ?? "", { redirect: "manual" });
    expect(launched.status).toBe(200);
    const html = await launched.text();
    expect(html).toContain(handle.sessionToken);
    expect(html).toContain(handle.csrfToken);
    expect(html).not.toContain("runtime-injected-");
    expect(launched.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");

    const cookie = launched.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^vocation-workbench=/);
    const routed = await fetch(`${handle.origin}/today`, { headers: { Cookie: cookie ?? "" } });
    expect(routed.status).toBe(200);
  });
});
