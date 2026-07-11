import { describe, expect, it } from "vitest";
import {
  advanceAgentRun,
  createAgentRun,
  workerCan,
  type AgentRun,
  type CapabilityScope,
  type WorkerManifest,
  type WorkerRole
} from "../../src/agent-controller.js";

const HASH = `sha256:${"a".repeat(64)}`;

function manifest(
  workerId: string,
  role: WorkerRole,
  capability: CapabilityScope
): WorkerManifest {
  return {
    workerId,
    role,
    readScopes: capability.startsWith("read:") ? [capability] : [],
    writeScopes: capability.startsWith("write:") ? [capability] : [],
    executeScopes: capability.startsWith("execute:") ? [capability] : [],
    toolAllowlist: [],
    maxSteps: 10,
    timeoutMs: 10_000,
    maxCostUsd: 1,
    stopConditions: ["phase-complete"]
  };
}

function manifests(): WorkerManifest[] {
  return [
    manifest("scout-1", "scout", "read:opportunities"),
    manifest("auditor-1", "evidence-auditor", "write:normalized-opportunity"),
    manifest("governor-1", "safety-governor", "write:policy-decision"),
    manifest("fit-1", "fit-analyst", "write:career-plan"),
    manifest("writer-1", "document-architect", "write:generated-artifact"),
    manifest("auditor-2", "evidence-auditor", "write:evaluation"),
    manifest("operator-1", "application-operator", "execute:application")
  ];
}

function throughGenerate(): AgentRun {
  let run = createAgentRun("OPP-DEMO-001", manifests());
  run = advanceAgentRun(run, { phase: "observe", actorId: "scout-1", actorType: "worker", role: "scout", outcome: "passed" });
  run = advanceAgentRun(run, { phase: "normalize", actorId: "auditor-1", actorType: "worker", role: "evidence-auditor", outcome: "passed" });
  run = advanceAgentRun(run, { phase: "gate", actorId: "governor-1", actorType: "worker", role: "safety-governor", outcome: "passed" });
  run = advanceAgentRun(run, { phase: "plan", actorId: "fit-1", actorType: "worker", role: "fit-analyst", outcome: "passed" });
  return advanceAgentRun(run, { phase: "generate", actorId: "writer-1", actorType: "worker", role: "document-architect", outcome: "passed", artifactHash: HASH });
}

describe("deterministic agent controller", () => {
  it("prevents the generator from evaluating its own output", () => {
    expect(() => advanceAgentRun(throughGenerate(), { phase: "evaluate", actorId: "writer-1", actorType: "worker", role: "evidence-auditor", outcome: "passed", artifactHash: HASH })).toThrow(
      "generator cannot evaluate"
    );
  });

  it("requires a human actor for approval", () => {
    const evaluated = advanceAgentRun(throughGenerate(), { phase: "evaluate", actorId: "auditor-2", actorType: "worker", role: "evidence-auditor", outcome: "passed", artifactHash: HASH });
    expect(() => advanceAgentRun(evaluated, { phase: "approve", actorId: "governor-1", actorType: "worker", role: "safety-governor", outcome: "passed" })).toThrow(
      "Approval requires a human actor"
    );
  });

  it("blocks out of order execution", () => {
    expect(() => advanceAgentRun(createAgentRun("OPP-DEMO-001", manifests()), { phase: "execute", actorId: "operator-1", actorType: "worker", role: "application-operator", outcome: "passed", artifactHash: HASH })).toThrow(
      "Expected phase observe"
    );
  });

  it("enforces capability scopes at the phase boundary", () => {
    const run = createAgentRun("OPP-DEMO-001", [manifest("scout-1", "scout", "read:claims")]);
    expect(() => advanceAgentRun(run, { phase: "observe", actorId: "scout-1", actorType: "worker", role: "scout", outcome: "passed" })).toThrow(
      "lacks read:opportunities"
    );
  });

  it("keeps execute capabilities separate from write capabilities", () => {
    const writer = manifest("writer-1", "document-architect", "write:generated-artifact");
    expect(workerCan(writer, "write:generated-artifact")).toBe(true);
    expect(workerCan(writer, "execute:application")).toBe(false);
  });

  it("rejects placeholder artifact hashes", () => {
    expect(() => advanceAgentRun(throughGenerate(), { phase: "evaluate", actorId: "auditor-2", actorType: "worker", role: "evidence-auditor", outcome: "passed", artifactHash: "sha256:evaluated" })).toThrow(
      "canonical SHA-256"
    );
  });
});
