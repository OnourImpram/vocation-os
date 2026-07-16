import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkbenchApp, type WorkbenchAppProps } from "./app.js";

export function mountWorkbench(element: Element, props: WorkbenchAppProps): Root {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <WorkbenchApp {...props} />
    </StrictMode>
  );
  return root;
}
