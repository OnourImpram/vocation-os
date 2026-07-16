#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repositoryRoot, "packages", "desktop", "src-tauri", "Cargo.toml");
const lockPath = resolve(repositoryRoot, "packages", "desktop", "src-tauri", "Cargo.lock");
const advisory = "GHSA-wrw7-89jp-8q8g";
const dependency = "glib@0.18.5";
const dependencyLine = "glib v0.18.5";
const windowsTarget = "x86_64-pc-windows-msvc";

function fail(message) {
  console.error(`Native dependency boundary check failed: ${message}`);
  process.exit(1);
}

function cargoTree(target) {
  const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
  const rustupCargo = resolve(homedir(), ".cargo", "bin", cargoName);
  const cargo = process.env.CARGO?.trim() || (existsSync(rustupCargo) ? rustupCargo : cargoName);
  const result = spawnSync(cargo, [
    "tree",
    "--locked",
    "--manifest-path",
    manifestPath,
    "--target",
    target,
    "--invert",
    dependency
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });

  if (result.error) {
    fail(`Cargo could not inspect ${target}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    fail(`Cargo dependency inspection failed for ${target}${detail ? `: ${detail}` : "."}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

const lock = readFileSync(lockPath, "utf8");
if (!lock.includes('name = "glib"\nversion = "0.18.5"')) {
  fail(`${advisory} is no longer present at the reviewed version. Remove its dependency-review exception.`);
}

const allTargets = cargoTree("all");
if (!allTargets.includes(dependencyLine) || !allTargets.includes("tauri v2.11.5")) {
  fail(`${advisory} no longer has the reviewed Tauri target-only path. Reassess and remove its exception.`);
}

const windowsGraph = cargoTree(windowsTarget);
if (windowsGraph.includes(dependencyLine)) {
  fail(`${advisory} reached the supported ${windowsTarget} release graph.`);
}

console.log(
  `Native dependency boundary passed. ${advisory} remains confined to Tauri's non-Windows graph and is absent from ${windowsTarget}.`
);
