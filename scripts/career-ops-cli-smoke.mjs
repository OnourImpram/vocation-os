#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const cliPath = path.join(process.cwd(), "dist", "career-ops-cli.js");

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireSuccess(label, result) {
  if (!result.error && result.status === 0) return result.stdout;
  throw new Error(`${label} failed with status ${String(result.status)}\n${result.stderr || result.stdout}`);
}

const adapters = JSON.parse(requireSuccess("career operations adapter listing", run(["adapters"])));
requireCondition(Array.isArray(adapters.adapters), "adapter listing did not return an adapters array");
requireCondition(adapters.adapters.length === 1, "alpha must ship exactly one career execution adapter");
requireCondition(
  adapters.adapters[0]?.adapterId === "career-ops-local-fixture"
    && adapters.adapters[0]?.maturity === "synthetic",
  "alpha shipped adapter identity or maturity is incorrect"
);

const demo = JSON.parse(requireSuccess(
  "career operations synthetic demo",
  run(["demo", "--at", "2026-08-28T09:00:00.000Z"])
));
requireCondition(demo.verification?.status === "verified", "synthetic demo verification did not pass");
requireCondition(demo.legitimacy?.tier === "green", "synthetic demo legitimacy was not green");
requireCondition(demo.grantDecision?.allowed === true, "synthetic demo execution grant was denied");
requireCondition(demo.outbox?.status === "confirmed", "synthetic demo Outbox did not confirm");
requireCondition(demo.applicationAttempt?.status === "confirmed", "synthetic application did not confirm");
requireCondition(demo.proofEvaluation?.status === "confirmed", "synthetic proof did not confirm");
requireCondition(demo.privateKeyMaterialPresent === false, "synthetic demo exposed private key material");

const unknown = run(["send-real-applications"]);
requireCondition(unknown.status === 2, "unknown career operations command did not fail closed");
requireCondition(
  `${unknown.stdout}${unknown.stderr}`.includes("Unknown career operations command"),
  "unknown career operations command did not explain the failure"
);

console.log("career operations CLI smoke passed");
