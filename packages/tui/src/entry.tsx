import { render, type Instance, type RenderOptions } from "ink";
import { VocationTuiApp, type VocationTuiAppProps } from "./app.js";

export interface RenderVocationTuiOptions extends VocationTuiAppProps {
  renderOptions?: RenderOptions;
}

export function renderVocationTui(options: RenderVocationTuiOptions): Instance {
  const { renderOptions, ...props } = options;
  return render(<VocationTuiApp {...props} />, renderOptions);
}
