# VocationOS Desktop

This package is a fail closed Tauri 2 bootstrap for the authenticated local VocationOS workbench.

## Runtime contract

The desktop starts `vocation workbench --no-open` with fixed nonsecret arguments. That command starts or attaches to `vocationd`, creates an ephemeral gateway bound to `127.0.0.1`, and writes a one time launch URL to stdout. Rust captures that output through a private pipe. It does not inherit stdout or stderr and it never logs the URL.

The bootstrap rejects any response that does not match `bootstrap-contract.json`. The launch URL must use `http`, the literal host `127.0.0.1`, an explicit nondefault port, and one exact base64url launch token path. Credentials, query data, fragments, unknown envelope fields, oversized output, malformed JSON, and timeouts fail closed.

Tauri has no configured window. Rust creates one hidden, incognito webview only after bootstrap validation. Every navigation must retain the exact parsed origin. New windows and downloads are denied. The one time launch path is removed from browser history before the window becomes visible.

The desktop exposes no Tauri commands, plugins, capabilities, asset protocol, global API, database access, credential access, or browser callable process API. The packaged local page is a scriptless fallback with `default-src 'none'`. Workbench bearer and CSRF material is generated and injected by the loopback gateway. It is never passed to the desktop process command line.

## Launcher resolution

Release builds use one of these trusted launch paths.

1. `VOCATION_OS_CLI_PATH` set to an absolute regular file.
2. An adjacent `vocation-cli` or `vocation` native executable.

Shell scripts such as `.cmd`, `.bat`, and `.ps1` are rejected. If `VOCATION_OS_CLI_PATH` names a JavaScript file in a release build, `VOCATION_OS_NODE_PATH` must name an absolute Node executable. Debug builds can use the repository `dist/cli.js` and resolve Node from `PATH`.

The current Tauri bundle does not yet declare a native sidecar. Distribution packaging must provide the adjacent launcher or configure both absolute paths. Missing launch authority exits without creating a window. Version 0.6 validates and bundles only Windows `msi` and `nsis` targets. Linux and macOS native artifacts remain blocked until their dependency and packaging contracts receive equivalent release evidence.

## Commands

```bash
npm run build --workspace @vocation-os/desktop
npm run validate --workspace @vocation-os/desktop
npm run build:desktop --workspace @vocation-os/desktop
npm run dev --workspace @vocation-os/desktop
```

The first command builds the canonical React workbench and runs desktop validation. Native commands require Rust `1.77.2` or newer and the platform prerequisites documented by Tauri.

`scripts/validate-contract.mjs` and the Node tests run without Rust. Native Rust tests, formatting, Clippy, and the Windows-only dependency boundary are enforced by the desktop workflow.
