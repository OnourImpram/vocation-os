import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  BadgeCheck,
  BriefcaseBusiness,
  CalendarDays,
  ClipboardCheck,
  FileCheck2,
  FileText,
  Fingerprint,
  GitBranch,
  KeyRound,
  MessagesSquare,
  RefreshCw,
  Scale,
  Search,
  Settings,
  ShieldCheck
} from "lucide-react";
import {
  WORKBENCH_ROUTES,
  createWorkbenchViewModel,
  routeById,
  routeFromPath,
  type LoopbackClient,
  type WorkbenchAction,
  type WorkbenchListItem,
  type WorkbenchRoute,
  type WorkbenchRouteId,
  type WorkbenchRoutePayload
} from "./index.js";

export interface WorkbenchAppProps {
  client: LoopbackClient;
  csrfToken: string;
}

type RouteIcon = ComponentType<Readonly<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>>;

const ROUTE_ICONS: Readonly<Record<WorkbenchRouteId, RouteIcon>> = {
  today: CalendarDays,
  discovery: Search,
  review: ClipboardCheck,
  twin: GitBranch,
  documents: FileText,
  pipeline: BriefcaseBusiness,
  evidence: FileCheck2,
  approvals: ShieldCheck,
  audit: Fingerprint,
  credentials: KeyRound,
  interview: MessagesSquare,
  offers: Scale,
  settings: Settings
};

const NAV_GROUPS: readonly WorkbenchRoute["group"][] = [
  "focus",
  "workspace",
  "governance",
  "growth",
  "system"
];

const GROUP_LABELS: Readonly<Record<WorkbenchRoute["group"], string>> = {
  focus: "Focus",
  workspace: "Workspace",
  governance: "Governance",
  growth: "Growth",
  system: "System"
};

function currentRoute(): WorkbenchRouteId {
  if (typeof window === "undefined") return "today";
  return routeFromPath(window.location.pathname)?.id ?? "today";
}

function StatusBadge({ item }: Readonly<{ item: WorkbenchListItem }>) {
  return <span className={`status-badge status-${item.tone}`}>{item.status}</span>;
}

function RouteContent(props: Readonly<{
  payload: WorkbenchRoutePayload;
  pendingAction: string | null;
  onAction(action: WorkbenchAction): void;
}>) {
  return (
    <>
      {props.payload.metrics.length > 0 ? (
        <section className="metrics-grid" aria-label="Current metrics">
          {props.payload.metrics.map((metric) => (
            <article className="metric" key={metric.id}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              {metric.detail ? <small>{metric.detail}</small> : null}
            </article>
          ))}
        </section>
      ) : null}

      <section className="route-content">
        <div className="record-list" aria-label="Route records">
          {props.payload.items.length === 0 ? (
            <div className="empty-state">
              <FileCheck2 size={28} aria-hidden />
              <h2>No records returned</h2>
              <p>The daemon has no current records for this view.</p>
            </div>
          ) : props.payload.items.map((item) => (
            <article className="record-row" key={item.id}>
              <div className="record-heading">
                <div>
                  <h2>{item.title}</h2>
                  <p>{item.subtitle}</p>
                </div>
                <StatusBadge item={item} />
              </div>
              {item.fields.length > 0 ? (
                <dl className="record-fields">
                  {item.fields.map((field) => (
                    <div key={`${item.id}-${field.label}`}>
                      <dt>{field.label}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </article>
          ))}
        </div>

        {props.payload.details.length > 0 ? (
          <aside className="detail-rail" aria-label="Selected detail">
            <h2>Detail</h2>
            <dl>
              {props.payload.details.map((field) => (
                <div key={field.label}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </aside>
        ) : null}
      </section>

      {props.payload.actions.length > 0 ? (
        <section className="action-bar" aria-label="Available actions">
          {props.payload.actions.map((action) => (
            <button
              className={`command-button command-${action.tone}`}
              disabled={props.pendingAction !== null}
              key={action.id}
              onClick={() => props.onAction(action)}
              type="button"
            >
              {props.pendingAction === action.id ? <RefreshCw className="spin" size={17} aria-hidden /> : null}
              {action.label}
              {action.approvalId ? <BadgeCheck size={17} aria-label="Scoped approval bound" /> : null}
            </button>
          ))}
        </section>
      ) : null}
    </>
  );
}

export function WorkbenchApp({ client, csrfToken }: WorkbenchAppProps) {
  const [routeId, setRouteId] = useState<WorkbenchRouteId>(currentRoute);
  const [payload, setPayload] = useState<WorkbenchRoutePayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const route = routeById(routeId);

  useEffect(() => {
    if (window.location.pathname === "/") window.history.replaceState({}, "", route.path);
    const handlePopState = () => setRouteId(currentRoute());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [route.path]);

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setMessage(null);
    void client.read<WorkbenchRoutePayload>(`/api/workbench/${route.id}`, controller.signal)
      .then((nextPayload) => {
        setPayload(nextPayload);
        setState(nextPayload.items.length === 0 && nextPayload.metrics.length === 0 ? "empty" : "ready");
      })
      .catch((error: unknown) => {
        if (error && typeof error === "object" && "name" in error && error.name === "AbortError") return;
        setPayload(null);
        setState("error");
        setMessage(error instanceof Error ? error.message : "Loopback request failed");
      });
    return () => controller.abort();
  }, [client, refreshSequence, route.id]);

  const viewModel = useMemo(() => createWorkbenchViewModel({
    route: route.id,
    state,
    data: payload,
    message
  }), [message, payload, route.id, state]);

  const navigate = useCallback((nextRoute: WorkbenchRoute) => {
    if (nextRoute.id === route.id) return;
    window.history.pushState({}, "", nextRoute.path);
    setRouteId(nextRoute.id);
  }, [route.id]);

  const executeAction = useCallback(async (action: WorkbenchAction) => {
    if (action.requiresConfirmation && !window.confirm(`Confirm ${action.label}?`)) return;
    setPendingAction(action.id);
    setMessage(null);
    try {
      await client.command(action.endpoint, { routeId: route.id, actionId: action.id }, {
        csrfToken,
        capability: action.capability,
        ...(action.approvalId ? { approvalId: action.approvalId } : {})
      });
      setRefreshSequence((value) => value + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Loopback command failed");
    } finally {
      setPendingAction(null);
    }
  }, [client, csrfToken, route.id]);

  return (
    <div className="workbench-shell">
      <aside className="sidebar">
        <div className="product-mark">
          <span className="product-glyph">VO</span>
          <div>
            <strong>VocationOS</strong>
            <span>Local workbench</span>
          </div>
        </div>
        <nav aria-label="Workbench navigation">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group}>
              <span className="nav-group-label">{GROUP_LABELS[group]}</span>
              {WORKBENCH_ROUTES.filter((candidate) => candidate.group === group).map((candidate) => {
                const Icon = ROUTE_ICONS[candidate.id];
                return (
                  <button
                    aria-label={candidate.title}
                    aria-current={candidate.id === route.id ? "page" : undefined}
                    className="nav-item"
                    key={candidate.id}
                    onClick={() => navigate(candidate)}
                    title={candidate.title}
                    type="button"
                  >
                    <Icon size={18} strokeWidth={1.8} aria-hidden />
                    <span>{candidate.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <main className="main-surface">
        <header className="route-header">
          <div>
            <p className="route-context">{GROUP_LABELS[route.group]}</p>
            <h1>{route.title}</h1>
          </div>
          <button
            aria-label="Refresh current view"
            className="icon-button"
            disabled={state === "loading"}
            onClick={() => setRefreshSequence((value) => value + 1)}
            title="Refresh"
            type="button"
          >
            <RefreshCw className={state === "loading" ? "spin" : undefined} size={19} aria-hidden />
          </button>
        </header>

        <div className="route-summary" aria-live="polite">
          {payload?.summary ?? (state === "loading" ? "Loading daemon state" : "No current summary")}
        </div>

        {state === "loading" ? (
          <div className="loading-state" aria-label="Loading current route">
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {viewModel.state === "error" ? (
          <section className="error-state" role="alert">
            <ShieldCheck size={24} aria-hidden />
            <div>
              <h2>Daemon read failed</h2>
              <p>{viewModel.message}</p>
            </div>
          </section>
        ) : null}

        {payload && state !== "loading" ? (
          <RouteContent payload={payload} pendingAction={pendingAction} onAction={(action) => void executeAction(action)} />
        ) : null}

        {message && state !== "error" ? <p className="inline-error" role="alert">{message}</p> : null}

        <footer className="runtime-status">
          <span className={`runtime-dot ${state === "error" ? "runtime-error" : ""}`} />
          <span>{state === "error" ? "Loopback unavailable" : "Loopback connected"}</span>
          {payload?.generatedAt ? <time dateTime={payload.generatedAt}>{payload.generatedAt}</time> : null}
        </footer>
      </main>
    </div>
  );
}
