import { randomUUID } from "node:crypto";

export const WORKER_ROLES = [
  "scout",
  "evidence-auditor",
  "fit-analyst",
  "portfolio-strategist",
  "document-architect",
  "application-operator",
  "network-strategist",
  "interview-coach",
  "offer-analyst",
  "outcome-scientist",
  "safety-governor"
] as const;

export const AGENT_PHASES = ["observe", "normalize", "gate", "plan", "generate", "evaluate", "approve", "execute", "verify", "learn"] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];
export type AgentPhase = (typeof AGENT_PHASES)[number];
export type CapabilityScope = `${"read" | "write" | "execute"}:${string}`;

export interface WorkerManifest {
  workerId: string;
  role: WorkerRole;
  readScopes: CapabilityScope[];
  writeScopes: CapabilityScope[];
  executeScopes: CapabilityScope[];
  toolAllowlist: string[];
  maxSteps: number;
  timeoutMs: number;
  maxCostUsd: number;
  stopConditions: string[];
}

export interface AgentPhaseRecord {
  phase: AgentPhase;
  actorId: string;
  actorType: "worker" | "human";
  role: WorkerRole | null;
  outcome: "passed" | "blocked";
  artifactHash: string | null;
  recordedAt: string;
}

export interface AgentRun {
  runId: string;
  opportunityId: string;
  status: "active" | "blocked" | "completed";
  workerManifests: WorkerManifest[];
  records: AgentPhaseRecord[];
  generatorActorId: string | null;
  evaluatorActorId: string | null;
}

const PHASE_ROLES: Record<Exclude<AgentPhase, "approve">, readonly WorkerRole[]> = {
  observe: ["scout"],
  normalize: ["scout", "evidence-auditor"],
  gate: ["safety-governor"],
  plan: ["fit-analyst", "portfolio-strategist"],
  generate: ["document-architect", "network-strategist", "interview-coach", "offer-analyst"],
  evaluate: ["evidence-auditor", "fit-analyst", "safety-governor"],
  execute: ["application-operator"],
  verify: ["evidence-auditor", "safety-governor"],
  learn: ["outcome-scientist"]
};

const PHASE_CAPABILITIES: Record<Exclude<AgentPhase, "approve">, CapabilityScope> = {
  observe: "read:opportunities",
  normalize: "write:normalized-opportunity",
  gate: "write:policy-decision",
  plan: "write:career-plan",
  generate: "write:generated-artifact",
  evaluate: "write:evaluation",
  execute: "execute:application",
  verify: "write:verification",
  learn: "write:outcome-model"
};

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function validateWorkerManifest(manifest: WorkerManifest): void {
  if (!manifest.workerId.trim()) throw new Error("Worker id is required");
  if (!WORKER_ROLES.includes(manifest.role)) throw new Error(`Unknown worker role: ${manifest.role}`);
  if (!Number.isInteger(manifest.maxSteps) || manifest.maxSteps < 1) throw new Error("Worker maxSteps must be positive");
  if (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 100) throw new Error("Worker timeout must be at least 100 ms");
  if (!Number.isFinite(manifest.maxCostUsd) || manifest.maxCostUsd < 0) throw new Error("Worker cost budget must be non-negative");
  if (manifest.stopConditions.length === 0 || manifest.stopConditions.some((condition) => !condition.trim())) {
    throw new Error("Worker manifests require at least one explicit stop condition");
  }
  const scopeGroups: Array<[string, CapabilityScope[], string]> = [
    ["read", manifest.readScopes, "read:"],
    ["write", manifest.writeScopes, "write:"],
    ["execute", manifest.executeScopes, "execute:"]
  ];
  for (const [label, scopes, prefix] of scopeGroups) {
    if (scopes.some((scope) => !scope.startsWith(prefix))) throw new Error(`${label} scopes must use the ${prefix} prefix`);
    if (new Set(scopes).size !== scopes.length) throw new Error(`${label} scopes must not contain duplicates`);
  }
}

export function workerCan(manifest: WorkerManifest, capability: CapabilityScope): boolean {
  validateWorkerManifest(manifest);
  if (capability.startsWith("read:")) return manifest.readScopes.includes(capability);
  if (capability.startsWith("write:")) return manifest.writeScopes.includes(capability);
  return manifest.executeScopes.includes(capability);
}

export function createAgentRun(opportunityId: string, workerManifests: WorkerManifest[]): AgentRun {
  for (const manifest of workerManifests) validateWorkerManifest(manifest);
  if (new Set(workerManifests.map((manifest) => manifest.workerId)).size !== workerManifests.length) {
    throw new Error("Agent runs require unique worker ids");
  }
  return {
    runId: `RUN-${randomUUID()}`,
    opportunityId,
    status: "active",
    workerManifests: workerManifests.map((manifest) => ({
      ...manifest,
      readScopes: [...manifest.readScopes],
      writeScopes: [...manifest.writeScopes],
      executeScopes: [...manifest.executeScopes],
      toolAllowlist: [...manifest.toolAllowlist],
      stopConditions: [...manifest.stopConditions]
    })),
    records: [],
    generatorActorId: null,
    evaluatorActorId: null
  };
}

export interface AdvanceAgentInput {
  phase: AgentPhase;
  actorId: string;
  actorType: "worker" | "human";
  role?: WorkerRole;
  outcome: "passed" | "blocked";
  artifactHash?: string;
  now?: Date;
}

export function advanceAgentRun(run: AgentRun, input: AdvanceAgentInput): AgentRun {
  if (run.status !== "active") throw new Error(`Agent run is ${run.status}`);
  const expectedPhase = AGENT_PHASES[run.records.length];
  if (input.phase !== expectedPhase) throw new Error(`Expected phase ${expectedPhase ?? "none"}, received ${input.phase}`);
  if (input.phase === "evaluate" && input.actorId === run.generatorActorId) {
    throw new Error("The generator cannot evaluate its own output");
  }

  if (input.phase === "approve") {
    if (input.actorType !== "human" || input.role !== undefined) throw new Error("Approval requires a human actor without a worker role");
  } else {
    if (input.actorType !== "worker" || !input.role) throw new Error(`${input.phase} requires an authorized worker role`);
    if (!PHASE_ROLES[input.phase].includes(input.role)) throw new Error(`${input.role} cannot perform ${input.phase}`);
    const manifest = run.workerManifests.find((candidate) => candidate.workerId === input.actorId);
    if (!manifest || manifest.role !== input.role) throw new Error(`${input.actorId} has no matching registered worker manifest`);
    const requiredCapability = PHASE_CAPABILITIES[input.phase];
    if (!workerCan(manifest, requiredCapability)) {
      throw new Error(`${input.actorId} lacks ${requiredCapability} capability for ${input.phase}`);
    }
  }
  if ((input.phase === "generate" || input.phase === "evaluate" || input.phase === "execute" || input.phase === "verify") && !input.artifactHash) {
    throw new Error(`${input.phase} requires an artifact hash`);
  }
  if (input.artifactHash && !SHA256_PATTERN.test(input.artifactHash)) {
    throw new Error(`${input.phase} artifact hash must be a canonical SHA-256 value`);
  }

  const record: AgentPhaseRecord = {
    phase: input.phase,
    actorId: input.actorId,
    actorType: input.actorType,
    role: input.role ?? null,
    outcome: input.outcome,
    artifactHash: input.artifactHash ?? null,
    recordedAt: (input.now ?? new Date()).toISOString()
  };
  const records = [...run.records, record];
  const blocked = input.outcome === "blocked";
  const completed = input.phase === "learn" && input.outcome === "passed";
  return {
    ...run,
    status: blocked ? "blocked" : completed ? "completed" : "active",
    records,
    generatorActorId: input.phase === "generate" ? input.actorId : run.generatorActorId,
    evaluatorActorId: input.phase === "evaluate" ? input.actorId : run.evaluatorActorId
  };
}
