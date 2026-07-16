import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBootstrapContract, parseBootstrapEnvelope } from "./bootstrap-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = resolve(packageRoot, "src-tauri");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertLockedDownCsp(csp, name) {
  assert(csp && typeof csp === "object" && !Array.isArray(csp), `${name} CSP must be explicit`);
  for (const [directive, value] of Object.entries(csp)) {
    assert(value === "'none'", `${name} CSP directive ${directive} must be none`);
  }
  for (const directive of ["default-src", "script-src", "connect-src", "object-src", "base-uri", "form-action", "frame-src"]) {
    assert(csp[directive] === "'none'", `${name} CSP must deny ${directive}`);
  }
}

const config = await readJson(resolve(tauriRoot, "tauri.conf.json"));
const packageManifest = await readJson(resolve(packageRoot, "package.json"));
const bootstrapContract = parseBootstrapContract(await readJson(resolve(packageRoot, "bootstrap-contract.json")));
const rustSource = [
  await readFile(resolve(tauriRoot, "src", "lib.rs"), "utf8"),
  await readFile(resolve(tauriRoot, "src", "main.rs"), "utf8")
].join("\n");
const productionRust = rustSource.split("#[cfg(test)]", 1)[0];
const fallbackHtml = await readFile(resolve(packageRoot, "frontend", "index.html"), "utf8");
const cargoManifest = await readFile(resolve(tauriRoot, "Cargo.toml"), "utf8");

assert(packageManifest.private === true, "Desktop package must remain private");
assert(config.identifier === "com.onourimpram.vocationos", "Unexpected application identifier");
assert(config.build?.beforeBuildCommand === "npm run build --workspace @vocation-os/workbench", "Native builds must build the canonical workbench");
assert(config.build?.beforeDevCommand === "npm run build --workspace @vocation-os/workbench", "Development must use the production workbench build");
assert(!("devUrl" in config.build), "Desktop must not load a development server URL");
assert(config.build?.frontendDist === "../frontend", "Tauri frontendDist must be the inert desktop fallback");
assert(config.build?.removeUnusedCommands === true, "Unused Tauri commands must be removed");
assert(config.app?.withGlobalTauri === false, "Global Tauri API must remain disabled");
assert(Array.isArray(config.app?.windows) && config.app.windows.length === 0, "No static webview window may be configured");
assert(Array.isArray(config.app?.security?.capabilities) && config.app.security.capabilities.length === 0, "No Tauri capabilities may be enabled");
assert(config.app?.security?.freezePrototype === true, "Prototype freezing must remain enabled");
assert(config.app?.security?.assetProtocol?.enable === false, "Asset protocol must remain disabled");
assertLockedDownCsp(config.app?.security?.csp, "Production");
assertLockedDownCsp(config.app?.security?.devCsp, "Development");
assert(config.plugins && Object.keys(config.plugins).length === 0, "Desktop must not enable plugins");

let capabilityFiles = [];
try {
  capabilityFiles = (await readdir(resolve(tauriRoot, "capabilities"))).filter((name) => name.endsWith(".json"));
} catch (error) {
  if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
}
assert(capabilityFiles.length === 0, "Desktop must not ship capability manifests");

assert(!/<script\b/iu.test(fallbackHtml), "Fallback page must not execute scripts");
assert(!/runtime-injected|sessionToken|csrfToken|https?:\/\//u.test(fallbackHtml), "Fallback page must not contain runtime credentials or remote URLs");
assert(fallbackHtml.includes("default-src 'none'"), "Fallback page must fail closed under CSP");

for (const required of [
  "Command::new",
  ".args([\"workbench\", \"--no-open\"])",
  ".stdout(Stdio::piped())",
  "limit.saturating_sub(buffer.len())",
  "remaining.min(chunk.len())",
  ".stderr(Stdio::null())",
  ".env_remove(\"NODE_OPTIONS\")",
  ".env_remove(\"NODE_PATH\")",
  "WebviewUrl::External",
  ".on_navigation",
  "url.origin().ascii_serialization()",
  ".on_new_window",
  "NewWindowResponse::Deny",
  ".on_download",
  ".incognito(true)",
  ".visible(false)",
  "window.history.replaceState",
  "tauri::RunEvent::ExitRequested",
  "app_handle.state::<BootstrapProcess>().stop()",
  "handle.state::<BootstrapProcess>().is_running()",
  "Instant::now() >= deadline",
  "#[serde(deny_unknown_fields)]"
]) {
  assert(rustSource.includes(required), `Rust bootstrap is missing required control: ${required}`);
}
for (const forbidden of [
  "invoke_handler",
  "tauri::command",
  ".plugin(",
  "cmd.exe",
  "powershell",
  "runtime-injected-",
  "println!",
  "eprintln!",
  "dbg!",
  "0.0.0.0",
  "localhost"
]) {
  assert(!productionRust.includes(forbidden), `Rust bootstrap contains forbidden surface: ${forbidden}`);
}
assert(cargoManifest.includes("serde_json = \"1\""), "Rust bootstrap must use structured JSON parsing");

const validToken = "A".repeat(43);
const parsed = parseBootstrapEnvelope(JSON.stringify({
  status: bootstrapContract.status,
  url: `http://127.0.0.1:43117/launch/${validToken}`,
  authority: bootstrapContract.authority,
  network: bootstrapContract.network
}), bootstrapContract);
assert(parsed.origin === "http://127.0.0.1:43117", "Reference bootstrap parser returned the wrong origin");

console.log("Desktop contract valid: private pipe bootstrap, exact loopback origin, no static authority.");
