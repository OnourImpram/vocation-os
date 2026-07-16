import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(process.cwd(), "packages", "desktop");
const tauriRoot = resolve(desktopRoot, "src-tauri");

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("desktop secure bootstrap contract", () => {
  it("builds the canonical workbench without configuring a static workbench URL", () => {
    const config = json(resolve(tauriRoot, "tauri.conf.json"));
    const build = config.build as Record<string, unknown>;

    expect(config.identifier).toBe("com.onourimpram.vocationos");
    expect(config.mainBinaryName).toBe("vocation-os");
    expect(build.beforeBuildCommand).toBe("npm run build --workspace @vocation-os/workbench");
    expect(build.beforeDevCommand).toBe("npm run build --workspace @vocation-os/workbench");
    expect(build.frontendDist).toBe("../frontend");
    expect(build).not.toHaveProperty("devUrl");
    expect(build.removeUnusedCommands).toBe(true);
  });

  it("creates no static window and exposes no Tauri capability", () => {
    const config = json(resolve(tauriRoot, "tauri.conf.json"));
    const app = config.app as Record<string, unknown>;
    const security = app.security as Record<string, unknown>;

    expect(app.windows).toEqual([]);
    expect(app.withGlobalTauri).toBe(false);
    expect(security.capabilities).toEqual([]);
    expect(existsSync(resolve(tauriRoot, "capabilities", "main.json"))).toBe(false);
  });

  it("fails closed to the Windows installer targets validated by this release", () => {
    const config = json(resolve(tauriRoot, "tauri.conf.json"));
    const bundle = config.bundle as Record<string, unknown>;

    expect(bundle.targets).toEqual(["msi", "nsis"]);
  });

  it("locks the inert local asset down without a daemon network allowance", () => {
    const config = json(resolve(tauriRoot, "tauri.conf.json"));
    const app = config.app as Record<string, unknown>;
    const security = app.security as Record<string, unknown>;
    const csp = security.csp as Record<string, string>;
    const fallback = readFileSync(resolve(desktopRoot, "frontend", "index.html"), "utf8");

    expect(Object.values(csp).every((value) => value === "'none'")).toBe(true);
    expect(csp["connect-src"]).toBe("'none'");
    expect(fallback).not.toMatch(/<script\b|runtime-injected|sessionToken|csrfToken|https?:\/\//iu);
  });

  it("uses a bounded private pipe and exact origin guarded external webview", () => {
    const rust = readFileSync(resolve(tauriRoot, "src", "lib.rs"), "utf8");
    const productionRust = rust.split("#[cfg(test)]", 1)[0] ?? rust;

    expect(rust).toContain(".args([\"workbench\", \"--no-open\"])");
    expect(rust).toContain(".stdout(Stdio::piped())");
    expect(rust).toContain("limit.saturating_sub(buffer.len())");
    expect(rust).toContain("remaining.min(chunk.len())");
    expect(rust).toContain("WebviewUrl::External");
    expect(rust).toContain("url.origin().ascii_serialization()");
    expect(rust).toContain("NewWindowResponse::Deny");
    expect(rust).toContain("window.history.replaceState");
    expect(rust).toContain("tauri::RunEvent::ExitRequested");
    expect(rust).toContain("app_handle.state::<BootstrapProcess>().stop()");
    expect(rust).toContain("handle.state::<BootstrapProcess>().is_running()");
    expect(rust).toContain("Instant::now() >= deadline");
    expect(productionRust).not.toMatch(/invoke_handler|tauri::command|\.plugin\(|cmd\.exe|powershell|runtime-injected|println!|eprintln!|dbg!/u);
  });

  it("pins the structured launch envelope to literal IPv4 loopback", () => {
    const contract = json(resolve(desktopRoot, "bootstrap-contract.json"));

    expect(contract).toMatchObject({
      schemaVersion: 1,
      authority: "vocationd",
      network: "127.0.0.1-only",
      scheme: "http",
      host: "127.0.0.1",
      launchPathPrefix: "/launch/",
      launchTokenBytes: 32
    });
  });
});
