import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 43117;
const SESSION_TOKEN = "runtime-injected-session-token-placeholder-0001";

const ROUTE_DATA = {
  today: {
    summary: "Three decisions need review before the next application window.",
    metrics: [
      { id: "queue", label: "Review queue", value: "3", detail: "Two approval bound" },
      { id: "evidence", label: "Evidence current", value: "94%", detail: "One source expires tomorrow" },
      { id: "providers", label: "Providers healthy", value: "21/24", detail: "Three assist only" }
    ],
    items: [
      {
        id: "today-1",
        title: "AI Safety Researcher",
        subtitle: "Example Lab, fully remote",
        status: "Ready for review",
        tone: "attention",
        fields: [
          { label: "Fit", value: "91" },
          { label: "Evidence", value: "Verified" },
          { label: "Route", value: "Official ATS" }
        ]
      },
      {
        id: "today-2",
        title: "Clinical Product Lead",
        subtitle: "Health Systems, Europe",
        status: "Prepared",
        tone: "neutral",
        fields: [
          { label: "Fit", value: "86" },
          { label: "Evidence", value: "Current" },
          { label: "Route", value: "Company careers" }
        ]
      }
    ],
    details: [
      { label: "Selected packet", value: "Clinical AI safety" },
      { label: "Approval", value: "Required before external action" },
      { label: "Last checkpoint", value: "Verified 12 minutes ago" }
    ],
    actions: [
      {
        id: "request-review",
        label: "Request review",
        endpoint: "/api/workbench/actions/request-review",
        capability: "review.request",
        approvalId: null,
        tone: "primary",
        requiresConfirmation: false
      }
    ]
  }
};

function routePayload(route) {
  const today = ROUTE_DATA.today;
  if (route === "today") return today;
  const title = route.charAt(0).toUpperCase() + route.slice(1);
  return {
    summary: `${title} state returned by the local daemon boundary.`,
    metrics: [
      { id: `${route}-current`, label: "Current", value: "12", detail: "Evidence bound" },
      { id: `${route}-review`, label: "Needs review", value: "2", detail: "No external action" }
    ],
    items: [{
      id: `${route}-1`,
      title: `${title} record`,
      subtitle: "Local daemon view",
      status: "Current",
      tone: "positive",
      fields: [
        { label: "Authority", value: "Daemon" },
        { label: "Evidence", value: "Verified" }
      ]
    }],
    details: [
      { label: "Route", value: title },
      { label: "Source", value: "Loopback client" }
    ],
    actions: []
  };
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${SESSION_TOKEN}`) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const routeMatch = /^\/api\/workbench\/([a-z-]+)$/u.exec(url.pathname);
  if (request.method === "GET" && routeMatch) {
    const route = routeMatch[1] ?? "today";
    json(response, 200, {
      ...routePayload(route),
      generatedAt: "2026-07-14T11:30:00.000Z"
    });
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/workbench/actions/")) {
    if (!request.headers["x-vocation-csrf"] || !request.headers["x-vocation-capability"]) {
      json(response, 403, { error: "command binding missing" });
      return;
    }
    json(response, 200, { accepted: true, requestId: "REQ-WORKBENCH-QA-1" });
    return;
  }
  json(response, 404, { error: "not found" });
});

server.listen(PORT, HOST);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
