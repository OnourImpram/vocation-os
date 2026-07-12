import { fork } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, stableStringify } from "../hash.js";
import { assertSchema } from "../schema.js";
import type { CareerFactCategory, CareerTwin, TemporalCareerFact } from "../career-twin.js";
import { assertArtifactManifest, type ArtifactManifest } from "../storage/artifact-vault.js";
import {
  preflightProfileArtifact,
  PROFILE_IMPORT_FORMATS,
  type ExtractedProfileText,
  type ProfileImportFormat,
  type ProfileParserResponse
} from "./profile-parser-worker.js";
import { PACKAGE_ROOT } from "../paths.js";

export interface ProfileImportCandidate {
  candidateId: string;
  text: string;
  category: CareerFactCategory;
  sourcePointer: string;
}

export interface ProfileImportPlan {
  version: 1;
  planHash: string;
  sourceManifest: ArtifactManifest;
  format: ProfileImportFormat;
  pageCount: number | null;
  textHash: string;
  candidateCount: number;
  candidates: ProfileImportCandidate[];
  warnings: string[];
  createdAt: string;
  approvalRequired: true;
}

const MAX_CANDIDATES = 500;
const MAX_CANDIDATE_CHARACTERS = 500;
const PARSER_TIMEOUT_MS = 30_000;

function dependencyReadRoot(): string {
  const resolved = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");
  let cursor = path.dirname(resolved);
  while (path.basename(cursor).toLowerCase() !== "node_modules") {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Profile parser dependency root could not be resolved");
    cursor = parent;
  }
  return cursor;
}

function parserModule(): { path: string; execArgv: string[] } {
  const sourceRuntime = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(sourceRuntime ? "./profile-parser-worker.ts" : "./profile-parser-worker.js", import.meta.url);
  return {
    path: fileURLToPath(moduleUrl),
    execArgv: [
      "--max-old-space-size=256",
      "--disallow-code-generation-from-strings",
      ...(sourceRuntime
        ? ["--import", "tsx"]
        : [
            "--permission",
            "--allow-addons",
            `--allow-fs-read=${PACKAGE_ROOT}`,
            `--allow-fs-read=${dependencyReadRoot()}`
          ])
    ]
  };
}

export async function parseProfileArtifact(data: Buffer, format: ProfileImportFormat): Promise<ExtractedProfileText> {
  if (!PROFILE_IMPORT_FORMATS.includes(format)) throw new Error("Unsupported profile import format");
  preflightProfileArtifact(data, format);
  const module = parserModule();
  return new Promise((resolve, reject) => {
    const child = fork(module.path, [], {
      execArgv: module.execArgv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
      env: {
        VOCATION_PROFILE_PARSER_WORKER: "1",
        NODE_NO_WARNINGS: "1",
        ...(process.env["SystemRoot"] ? { SystemRoot: process.env["SystemRoot"] } : {}),
        ...(process.env["WINDIR"] ? { WINDIR: process.env["WINDIR"] } : {}),
        ...(process.env["TEMP"] ? { TEMP: process.env["TEMP"] } : {}),
        ...(process.env["TMP"] ? { TMP: process.env["TMP"] } : {})
      }
    });
    let stderr = "";
    let response: ProfileParserResponse | null = null;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let escalation: ReturnType<typeof setTimeout> | null = null;
    const clearLifecycleTimers = (preserveEscalation = false): void => {
      if (timer) clearTimeout(timer);
      if (escalation && !preserveEscalation) clearTimeout(escalation);
    };
    const rejectOnce = (error: Error, preserveEscalation = false): void => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers(preserveEscalation);
      if (child.connected) child.disconnect();
      reject(error);
    };
    const resolveOnce = (result: ExtractedProfileText, preserveEscalation = false): void => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers(preserveEscalation);
      if (child.connected) child.disconnect();
      resolve(result);
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8").slice(0, 4_096 - stderr.length);
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000);
      rejectOnce(new Error("Profile parser exceeded its 30 second time limit and was terminated"), true);
    }, PARSER_TIMEOUT_MS);
    child.once("error", () => {
      child.kill("SIGKILL");
      rejectOnce(new Error("Profile parser process could not be started"));
    });
    child.once("close", (code) => {
      if (settled) {
        if (escalation) clearTimeout(escalation);
        return;
      }
      if (timedOut) {
        rejectOnce(new Error("Profile parser exceeded its 30 second time limit and was terminated"));
        return;
      }
      if (code !== 0 || !response) {
        rejectOnce(new Error(`Profile parser exited with code ${String(code)}${stderr ? ": parser diagnostics available" : ""}`));
        return;
      }
      if (response.type === "profile-parse-failed") rejectOnce(new Error(response.error));
      else resolveOnce(response.result);
    });
    child.once("message", (message: unknown) => {
      if (timedOut || settled) return;
      const candidate = message as Partial<ProfileParserResponse>;
      if (candidate.type === "profile-parse-failed" && typeof candidate.error === "string") {
        response = { type: candidate.type, error: candidate.error };
      } else if (candidate.type === "profile-parsed" && candidate.result) {
        response = { type: candidate.type, result: candidate.result };
      } else {
        response = { type: "profile-parse-failed", error: "Profile parser returned an invalid response" };
      }
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 1_000);
      if (response.type === "profile-parse-failed") rejectOnce(new Error(response.error), true);
      else resolveOnce(response.result, true);
    });
    try {
      child.send({ type: "parse-profile", format, data }, (error) => {
        if (!error) return;
        child.kill("SIGKILL");
        rejectOnce(new Error("Profile parser request could not be delivered"));
      });
    } catch {
      child.kill("SIGKILL");
      rejectOnce(new Error("Profile parser request could not be delivered"));
    }
  });
}

function classifyCandidate(text: string): CareerFactCategory {
  const normalized = text.toLowerCase();
  if (/\b(degree|university|phd|master|bachelor|license|certif)/.test(normalized)) return "credential";
  if (/\b(publication|journal|doi|conference|article|book)\b/.test(normalized)) return "artifact";
  if (/\b(skill|typescript|python|research|analysis|training|therapy|clinical)\b/.test(normalized)) return "skill";
  if (/\b(experience|worked|lecturer|researcher|manager|founder|consultant)\b/.test(normalized)) return "experience";
  return "career-narrative";
}

function candidateLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*[-*+•]\s*/u, "").trim().replace(/\s+/g, " ");
    if (line.length < 3 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line.slice(0, MAX_CANDIDATE_CHARACTERS));
    if (lines.length >= MAX_CANDIDATES) break;
  }
  return lines;
}

function planBody(plan: Omit<ProfileImportPlan, "planHash">): Omit<ProfileImportPlan, "planHash"> {
  return plan;
}

export function createProfileImportPlan(
  sourceManifest: ArtifactManifest,
  extracted: ExtractedProfileText,
  now = new Date()
): ProfileImportPlan {
  assertArtifactManifest(sourceManifest);
  if (!PROFILE_IMPORT_FORMATS.includes(extracted.format)) throw new Error("Unsupported extracted profile format");
  const lines = candidateLines(extracted.text);
  const candidates = lines.map<ProfileImportCandidate>((text, index) => ({
    candidateId: `CAND-${sha256(`${index}:${text}`).slice("sha256:".length, "sha256:".length + 20).toUpperCase()}`,
    text,
    category: classifyCandidate(text),
    sourcePointer: `artifact:${sourceManifest.storageLocator}:segment:${index + 1}`
  }));
  const warnings = [
    ...(lines.length === MAX_CANDIDATES ? [`candidate limit reached at ${MAX_CANDIDATES}`] : []),
    ...(candidates.length === 0 ? ["no candidate profile lines were extracted"] : []),
    "imported candidates remain operator supplied until claim review"
  ];
  const body = planBody({
    version: 1,
    sourceManifest,
    format: extracted.format,
    pageCount: extracted.pageCount,
    textHash: sha256(extracted.text),
    candidateCount: candidates.length,
    candidates,
    warnings,
    createdAt: now.toISOString(),
    approvalRequired: true
  });
  const plan: ProfileImportPlan = { ...body, planHash: sha256(stableStringify(body)) };
  assertProfileImportPlan(plan);
  return plan;
}

export function validateProfileImportPlan(plan: ProfileImportPlan): string[] {
  const errors: string[] = [];
  try {
    assertSchema("profile-import-plan", plan);
    assertArtifactManifest(plan.sourceManifest);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const { planHash, ...body } = plan;
  if (planHash !== sha256(stableStringify(body))) errors.push("profile import plan hash mismatch");
  if (plan.candidateCount !== plan.candidates.length) errors.push("profile import candidate count mismatch");
  if (new Set(plan.candidates.map((candidate) => candidate.candidateId)).size !== plan.candidates.length) {
    errors.push("duplicate profile import candidate id");
  }
  return errors;
}

export function assertProfileImportPlan(plan: ProfileImportPlan): void {
  const errors = validateProfileImportPlan(plan);
  if (errors.length > 0) throw new Error(`Profile import plan validation failed: ${errors.join("; ")}`);
}

export function careerTwinFromImportPlan(plan: ProfileImportPlan): CareerTwin {
  assertProfileImportPlan(plan);
  const facts = plan.candidates.map<TemporalCareerFact>((candidate, index) => ({
    factId: `FACT-IMPORT-${(index + 1).toString().padStart(4, "0")}`,
    category: candidate.category,
    label: candidate.text.slice(0, 120),
    value: candidate.text,
    validFrom: plan.createdAt,
    observedAt: plan.createdAt,
    evidenceStatus: "operator_supplied",
    sourcePointer: candidate.sourcePointer,
    confidence: "Low",
    sensitivity: "internal",
    allowedUses: ["analysis"]
  }));
  return {
    twinId: `LOCAL-TWIN-${plan.planHash.slice("sha256:".length, "sha256:".length + 32).toUpperCase()}`,
    profileScope: "local-private",
    twinVersion: 1,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    facts,
    goals: [],
    importProvenance: {
      planHash: plan.planHash,
      sourceContentHash: plan.sourceManifest.contentHash,
      sourceLocator: plan.sourceManifest.storageLocator
    }
  };
}
