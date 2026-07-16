import { createRoot } from "react-dom/client";
import { ShieldAlert } from "lucide-react";
import { createLoopbackClient } from "./index.js";
import { mountWorkbench } from "./entry.js";
import "./styles.css";

interface WorkbenchBootstrap {
  origin: string;
  sessionToken: string;
  csrfToken: string;
}

function bootstrapValue(documentValue: Document): WorkbenchBootstrap {
  const element = documentValue.getElementById("vocation-workbench-bootstrap");
  if (!element?.textContent) throw new Error("Workbench bootstrap is missing");
  const value = JSON.parse(element.textContent) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workbench bootstrap is invalid");
  }
  const fields = value as Record<string, unknown>;
  if (
    typeof fields.origin !== "string"
    || typeof fields.sessionToken !== "string"
    || typeof fields.csrfToken !== "string"
  ) {
    throw new Error("Workbench bootstrap fields are invalid");
  }
  return {
    origin: fields.origin === "self" ? `${window.location.origin}/` : fields.origin,
    sessionToken: fields.sessionToken,
    csrfToken: fields.csrfToken
  };
}

function BootstrapFailure({ message }: Readonly<{ message: string }>) {
  return (
    <main className="bootstrap-failure" role="alert">
      <ShieldAlert size={30} aria-hidden />
      <h1>Workbench unavailable</h1>
      <p>{message}</p>
    </main>
  );
}

const element = document.getElementById("root");
if (!element) throw new Error("Workbench root element is missing");

try {
  const bootstrap = bootstrapValue(document);
  const client = createLoopbackClient({
    origin: bootstrap.origin,
    sessionToken: bootstrap.sessionToken
  });
  mountWorkbench(element, { client, csrfToken: bootstrap.csrfToken });
} catch (error) {
  createRoot(element).render(
    <BootstrapFailure message={error instanceof Error ? error.message : "Runtime bootstrap failed"} />
  );
}
