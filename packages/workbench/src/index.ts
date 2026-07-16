export interface WorkbenchRouteDescriptor {
  id: string;
  path: string;
  title: string;
  group: "focus" | "workspace" | "governance" | "growth" | "system";
}

export const WORKBENCH_ROUTES = [
  { id: "today", path: "/today", title: "Today", group: "focus" },
  { id: "discovery", path: "/discovery", title: "Discovery", group: "workspace" },
  { id: "review", path: "/review", title: "Review", group: "workspace" },
  { id: "twin", path: "/twin", title: "Twin", group: "workspace" },
  { id: "documents", path: "/documents", title: "Documents", group: "workspace" },
  { id: "pipeline", path: "/pipeline", title: "Pipeline", group: "workspace" },
  { id: "evidence", path: "/evidence", title: "Evidence", group: "governance" },
  { id: "approvals", path: "/approvals", title: "Approvals", group: "governance" },
  { id: "audit", path: "/audit", title: "Audit", group: "governance" },
  { id: "credentials", path: "/credentials", title: "Credentials", group: "governance" },
  { id: "interview", path: "/interview", title: "Interview", group: "growth" },
  { id: "offers", path: "/offers", title: "Offers", group: "growth" },
  { id: "settings", path: "/settings", title: "Settings", group: "system" }
] as const satisfies readonly WorkbenchRouteDescriptor[];

export type WorkbenchRouteId = (typeof WORKBENCH_ROUTES)[number]["id"];
export type WorkbenchRoute = (typeof WORKBENCH_ROUTES)[number];

export interface NavigationItemViewModel {
  id: WorkbenchRouteId;
  path: string;
  label: string;
  group: WorkbenchRoute["group"];
  active: boolean;
}

export interface WorkbenchViewModel<T = unknown> {
  route: WorkbenchRoute;
  navigation: readonly NavigationItemViewModel[];
  state: "loading" | "ready" | "empty" | "error";
  data: T | null;
  message: string | null;
}

export interface WorkbenchMetric {
  id: string;
  label: string;
  value: string;
  detail: string | null;
}

export interface WorkbenchField {
  label: string;
  value: string;
}

export interface WorkbenchListItem {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  tone: "neutral" | "positive" | "attention" | "critical";
  fields: readonly WorkbenchField[];
}

export interface WorkbenchAction {
  id: string;
  label: string;
  endpoint: string;
  capability: string;
  approvalId: string | null;
  tone: "neutral" | "primary" | "danger";
  requiresConfirmation: boolean;
}

export interface WorkbenchRoutePayload {
  summary: string;
  generatedAt: string;
  metrics: readonly WorkbenchMetric[];
  items: readonly WorkbenchListItem[];
  details: readonly WorkbenchField[];
  actions: readonly WorkbenchAction[];
}

export function routeById(id: WorkbenchRouteId): WorkbenchRoute {
  const route = WORKBENCH_ROUTES.find((candidate) => candidate.id === id);
  if (!route) throw new Error(`Unknown workbench route: ${id}`);
  return route;
}

export function routeFromPath(pathname: string): WorkbenchRoute | null {
  const queryIndex = pathname.indexOf("?");
  const fragmentIndex = pathname.indexOf("#");
  const boundaries = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const pathEnd = boundaries.length === 0 ? pathname.length : Math.min(...boundaries);
  const routePath = pathname.slice(0, pathEnd);
  let cleanEnd = routePath.length;
  while (cleanEnd > 1 && routePath.charCodeAt(cleanEnd - 1) === 47) cleanEnd -= 1;
  const cleanPath = routePath.slice(0, cleanEnd) || "/";
  return WORKBENCH_ROUTES.find((route) => route.path === cleanPath) ?? null;
}

export function createNavigationViewModel(activeRoute: WorkbenchRouteId): readonly NavigationItemViewModel[] {
  return Object.freeze(WORKBENCH_ROUTES.map((route) => Object.freeze({
    id: route.id,
    path: route.path,
    label: route.title,
    group: route.group,
    active: route.id === activeRoute
  })));
}

export function createWorkbenchViewModel<T>(input: {
  route: WorkbenchRouteId;
  state: WorkbenchViewModel<T>["state"];
  data?: T | null;
  message?: string | null;
}): WorkbenchViewModel<T> {
  return Object.freeze({
    route: routeById(input.route),
    navigation: createNavigationViewModel(input.route),
    state: input.state,
    data: input.data ?? null,
    message: input.message ?? null
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class LoopbackClientError extends Error {
  public constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "LoopbackClientError";
  }
}

export type LoopbackFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LoopbackClientOptions {
  origin: string;
  sessionToken: string;
  fetch?: LoopbackFetch;
}

export interface LoopbackCommandOptions {
  csrfToken: string;
  capability: string;
  approvalId?: string;
  signal?: AbortSignal;
}

export interface LoopbackClient {
  readonly origin: string;
  read<T>(path: string, signal?: AbortSignal): Promise<T>;
  command<T>(path: string, body: unknown, options: LoopbackCommandOptions): Promise<T>;
}

function assertHeaderSecret(value: string, field: string): void {
  if (value.length < 32 || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new LoopbackClientError(`${field} must be an unbroken value of at least 32 characters`);
  }
}

function assertHeaderValue(value: string, field: string): void {
  if (value.trim().length === 0 || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new LoopbackClientError(`${field} must be a non-empty single-line value`);
  }
}

export function validateLoopbackOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new LoopbackClientError("Loopback origin must be an absolute URL");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new LoopbackClientError("Workbench gateway must bind to an explicit loopback host");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LoopbackClientError("Workbench gateway must use HTTP or HTTPS");
  }
  if (!url.port) {
    throw new LoopbackClientError("Workbench gateway must use an explicit port");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new LoopbackClientError("Loopback origin must not contain credentials, path, query, or fragment data");
  }
  return url;
}

export function resolveLoopbackApiUrl(origin: URL, path: string): URL {
  if ((!path.startsWith("/api/") && path !== "/api") || path.includes("\\") || path.includes("#")) {
    throw new LoopbackClientError("Loopback requests must use an absolute /api path");
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path.split("?", 1)[0] ?? path);
  } catch {
    throw new LoopbackClientError("Loopback API path contains invalid percent encoding");
  }
  if (
    decodedPath.includes("\\")
    || decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new LoopbackClientError("Loopback API path must not contain traversal segments");
  }
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) {
    throw new LoopbackClientError("Loopback API request cannot change origin");
  }
  return url;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new LoopbackClientError(`Loopback gateway returned HTTP ${response.status}`, response.status);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new LoopbackClientError("Loopback gateway returned a non-JSON response", response.status);
  }
  return await response.json() as T;
}

export function createLoopbackClient(options: LoopbackClientOptions): LoopbackClient {
  const origin = validateLoopbackOrigin(options.origin);
  assertHeaderSecret(options.sessionToken, "Session token");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    csrfToken?: string;
    capability?: string;
    approvalId?: string;
    signal?: AbortSignal;
  }): Promise<T> {
    const url = resolveLoopbackApiUrl(origin, input.path);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${options.sessionToken}`
    };
    if (input.method === "POST") {
      if (!input.csrfToken || !input.capability) {
        throw new LoopbackClientError("Loopback commands require CSRF and capability bindings");
      }
      assertHeaderSecret(input.csrfToken, "CSRF token");
      assertHeaderValue(input.capability, "Capability");
      headers["Content-Type"] = "application/json";
      headers["X-Vocation-CSRF"] = input.csrfToken;
      headers["X-Vocation-Capability"] = input.capability;
      if (input.approvalId) {
        assertHeaderValue(input.approvalId, "Approval id");
        headers["X-Vocation-Approval"] = input.approvalId;
      }
    }

    const init: RequestInit = {
      method: input.method,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(input.method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    };
    return parseJsonResponse<T>(await fetcher(url, init));
  }

  return Object.freeze({
    origin: origin.origin,
    read: <T>(path: string, signal?: AbortSignal) => request<T>({
      method: "GET",
      path,
      ...(signal ? { signal } : {})
    }),
    command: <T>(path: string, body: unknown, commandOptions: LoopbackCommandOptions) => request<T>({
      method: "POST",
      path,
      body,
      csrfToken: commandOptions.csrfToken,
      capability: commandOptions.capability,
      ...(commandOptions.approvalId ? { approvalId: commandOptions.approvalId } : {}),
      ...(commandOptions.signal ? { signal: commandOptions.signal } : {})
    })
  });
}
