import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { AuthorityOperation } from "@vocation-os/sdk";
import {
  WORKBENCH_ROUTE_IDS,
  buildWorkbenchRoutePayload,
  type WorkbenchRouteId
} from "./route-payload.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface LoopbackAuthorityClient {
  request(operation: AuthorityOperation, payload?: unknown, options?: { requestId?: string }): Promise<unknown>;
}

export interface LoopbackGatewayOptions {
  authority: LoopbackAuthorityClient;
  port?: number;
  maxBodyBytes?: number;
  staticRoot?: string;
}

export interface LoopbackGatewayHandle {
  origin: string;
  sessionToken: string;
  csrfToken: string;
  workbenchUrl: string | null;
  close(): Promise<void>;
}

interface Route {
  method: "GET" | "POST";
  operation: AuthorityOperation;
  payload: (body: unknown) => unknown;
  capability: string | null;
}

const ROUTES: Readonly<Record<string, Route>> = Object.freeze({
  "GET /api/health": route("GET", "health"),
  "GET /api/opportunities": route("GET", "domain-list", () => ({ domain: "opportunities" })),
  "GET /api/pipeline": route("GET", "tracker-list", () => ({})),
  "GET /api/approvals": route("GET", "approver-list"),
  "GET /api/audit": route("GET", "audit-export"),
  "GET /api/artifacts": route("GET", "artifact-list"),
  "GET /api/onboarding": route("GET", "onboarding-status"),
  "POST /api/safety/kill": route("POST", "auto-apply-kill", identity, "safety.kill"),
  "POST /api/tracker/approve": route("POST", "tracker-approve", identity, "pipeline.update"),
  "POST /api/tracker/block": route("POST", "tracker-block", identity, "pipeline.update")
});

function identity(value: unknown): unknown {
  return value;
}

function route(
  method: Route["method"],
  operation: AuthorityOperation,
  payload: (body: unknown) => unknown = () => ({}),
  capability: string | null = null
): Route {
  return Object.freeze({ method, operation, payload, capability });
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.byteLength,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(bytes);
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
});

function staticHeaders(contentType: string, nonce: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function cookieAuthenticated(request: IncomingMessage, sessionToken: string): boolean {
  const cookies = request.headers.cookie?.split(";").map((item) => item.trim()) ?? [];
  const cookie = cookies.find((item) => item.startsWith("vocation-workbench="));
  return cookie ? secureEqual(cookie.slice("vocation-workbench=".length), sessionToken) : false;
}

function safeStaticRoot(value: string | undefined): string | null {
  if (!value) return null;
  if (!path.isAbsolute(value)) throw new Error("Workbench static root must be absolute");
  const root = realpathSync(value);
  if (!statSync(root).isDirectory() || !existsSync(path.join(root, "index.html"))) {
    throw new Error("Workbench static root does not contain a production index.html");
  }
  return root;
}

function staticFile(root: string, pathname: string): { path: string; contentType: string } | null {
  const relative = pathname.startsWith("/assets/") || pathname === "/favicon.svg"
    ? pathname.slice(1)
    : "index.html";
  const candidate = path.resolve(root, relative);
  const rootPrefix = `${root}${path.sep}`;
  if (candidate !== path.join(root, "index.html") && !candidate.startsWith(rootPrefix)) return null;
  const extension = path.extname(candidate).toLowerCase();
  const contentType = STATIC_CONTENT_TYPES[extension];
  if (!contentType || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  const resolved = realpathSync(candidate);
  if (!resolved.startsWith(rootPrefix)) return null;
  return { path: resolved, contentType };
}

function bootstrapHtml(
  filePath: string,
  origin: string,
  sessionToken: string,
  csrfToken: string,
  nonce: string
): Buffer {
  const source = readFileSync(filePath, "utf8");
  const html = source
    .replace("runtime-injected-session-token-placeholder-0001", sessionToken)
    .replace("runtime-injected-csrf-token-placeholder-000001", csrfToken)
    .replace('id="vocation-workbench-bootstrap"', `id="vocation-workbench-bootstrap" nonce="${nonce}"`)
    .replace('"origin": "self"', `"origin": ${JSON.stringify(`${origin}/`)}`);
  if (html === source || html.includes("runtime-injected-")) {
    throw new Error("Workbench production index is missing its secure bootstrap placeholders");
  }
  return Buffer.from(html, "utf8");
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function authenticated(request: IncomingMessage, sessionToken: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  return secureEqual(authorization.slice("Bearer ".length), sessionToken);
}

function requestPath(request: IncomingMessage): string | null {
  if (!request.url) return null;
  let url: URL;
  try {
    url = new URL(request.url, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (url.search || url.hash || !url.pathname.startsWith("/api/")) return null;
  return url.pathname;
}

function workbenchRouteId(path: string): WorkbenchRouteId | null {
  const match = /^\/api\/workbench\/([a-z]+)$/u.exec(path);
  const candidate = match?.[1];
  return candidate && WORKBENCH_ROUTE_IDS.includes(candidate as WorkbenchRouteId)
    ? candidate as WorkbenchRouteId
    : null;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new GatewayRequestError(415, "application-json-required");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBodyBytes) throw new GatewayRequestError(413, "request-body-too-large");
    chunks.push(bytes);
  }
  if (total === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new GatewayRequestError(400, "json-object-required");
    }
    return value;
  } catch (error) {
    if (error instanceof GatewayRequestError) throw error;
    throw new GatewayRequestError(400, "invalid-json");
  }
}

class GatewayRequestError extends Error {
  public constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = "GatewayRequestError";
  }
}

function assertCommandHeaders(
  request: IncomingMessage,
  origin: string,
  csrfToken: string,
  requiredCapability: string
): void {
  if (request.headers.origin !== origin) throw new GatewayRequestError(403, "origin-binding-required");
  const csrf = request.headers["x-vocation-csrf"];
  if (typeof csrf !== "string" || !secureEqual(csrf, csrfToken)) {
    throw new GatewayRequestError(403, "csrf-binding-required");
  }
  if (request.headers["x-vocation-capability"] !== requiredCapability) {
    throw new GatewayRequestError(403, "capability-binding-required");
  }
}

function requestId(): string {
  return `REQ-WEB-${randomUUID()}`;
}

export async function startLoopbackGateway(options: LoopbackGatewayOptions): Promise<LoopbackGatewayHandle> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1024 * 1024) {
    throw new Error("Loopback maximum body size is invalid");
  }
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Loopback port is invalid");
  }
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const launchToken = randomBytes(32).toString("base64url");
  const cspNonce = randomBytes(24).toString("base64url");
  const staticRoot = safeStaticRoot(options.staticRoot);
  let origin = "";

  const server = createServer(async (request, response) => {
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress)) throw new GatewayRequestError(403, "loopback-only");
      const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const host = request.headers.host;
      if (host !== new URL(origin).host) throw new GatewayRequestError(403, "host-binding-required");
      const isApi = parsedUrl.pathname.startsWith("/api/");
      if (staticRoot && !isApi && request.method === "GET") {
        const launch = parsedUrl.pathname === `/launch/${launchToken}`;
        if (!launch && !cookieAuthenticated(request, sessionToken)) {
          throw new GatewayRequestError(401, "workbench-session-required");
        }
        const selected = staticFile(staticRoot, parsedUrl.pathname);
        if (!selected) throw new GatewayRequestError(404, "asset-not-found");
        const bytes = selected.contentType.startsWith("text/html")
          ? bootstrapHtml(selected.path, origin, sessionToken, csrfToken, cspNonce)
          : readFileSync(selected.path);
        response.writeHead(200, {
          ...staticHeaders(selected.contentType, cspNonce),
          "Content-Length": bytes.byteLength,
          ...(launch ? { "Set-Cookie": `vocation-workbench=${sessionToken}; HttpOnly; SameSite=Strict; Path=/` } : {})
        });
        response.end(bytes);
        return;
      }
      if (!authenticated(request, sessionToken)) throw new GatewayRequestError(401, "authentication-required");
      const path = requestPath(request);
      const method = request.method === "GET" || request.method === "POST" ? request.method : null;
      if (!path || !method) throw new GatewayRequestError(404, "route-not-found");
      const workbenchRoute = method === "GET" ? workbenchRouteId(path) : null;
      if (workbenchRoute) {
        const payload = await buildWorkbenchRoutePayload(workbenchRoute, options.authority, requestId);
        jsonResponse(response, 200, payload);
        return;
      }
      const selectedRoute = ROUTES[`${method} ${path}`];
      if (!selectedRoute) throw new GatewayRequestError(404, "route-not-found");

      let body: unknown = {};
      if (selectedRoute.method === "POST") {
        if (!selectedRoute.capability) throw new Error("Command route is missing a capability");
        assertCommandHeaders(request, origin, csrfToken, selectedRoute.capability);
        body = await readJsonBody(request, maxBodyBytes);
      }
      const result = await options.authority.request(
        selectedRoute.operation,
        selectedRoute.payload(body),
        { requestId: requestId() }
      );
      jsonResponse(response, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof GatewayRequestError) {
        jsonResponse(response, error.status, { ok: false, error: error.code });
        return;
      }
      jsonResponse(response, 500, { ok: false, error: "authority-request-failed" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || address.address !== LOOPBACK_HOST) {
    server.close();
    throw new Error("Loopback gateway did not bind to the required host");
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;

  return Object.freeze({
    origin,
    sessionToken,
    csrfToken,
    workbenchUrl: staticRoot ? `${origin}/launch/${launchToken}` : null,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  });
}
