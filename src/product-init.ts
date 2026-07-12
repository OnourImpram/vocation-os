import { randomUUID } from "node:crypto";
import type { AuthorityOperation, VocationRequestOptions } from "@vocation-os/sdk";
import { assertOnboardingSession, type ActionableOnboardingStep, type OnboardingSession } from "./onboarding.js";
import { sha256, stableStringify } from "./hash.js";
import { createOpportunityRecord } from "./opportunity.js";
import type { CareerTwin } from "./career-twin.js";
import type { ProfileImportFormat } from "./import/profile-parser-worker.js";

export type ProductInitMode = "demo" | "profile" | "resume";

export interface ProductInitClient {
  request(operation: AuthorityOperation, payload?: unknown, options?: VocationRequestOptions): Promise<unknown>;
}

export interface ProductInitOptions {
  mode: ProductInitMode;
  profilePath?: string;
}

export interface ProductInitResult {
  mode: ProductInitMode;
  session: OnboardingSession;
  artifactManifest: unknown | null;
  profileImportPlan: unknown | null;
  profileRecordId: string | null;
  opportunityRecordId: string | null;
  nextAction: "complete" | "claim-review" | "continue-onboarding";
}

const MAX_ONBOARDING_CONFLICT_RETRIES = 3;

function profileFormat(filePath: string): ProfileImportFormat {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".pdf")) return "pdf";
  if (normalized.endsWith(".docx")) return "docx";
  if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) return "markdown";
  if (normalized.endsWith(".txt")) return "text";
  throw new Error("Profile source must be PDF, DOCX, Markdown, or UTF-8 text");
}

function requestId(session: OnboardingSession, suffix: string): string {
  const safeSuffix = suffix.replace(/[^A-Za-z0-9-]/g, "-").toUpperCase();
  return `REQ-INIT-${session.sessionId}-${safeSuffix}`;
}

function redactedPointer(session: OnboardingSession, step: ActionableOnboardingStep): `redacted:${string}` {
  const hex = sha256(`${session.sessionId}:${step}:result-pointer`).slice("sha256:".length);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `redacted:${uuid}`;
}

function sessionFrom(value: unknown): OnboardingSession {
  assertOnboardingSession(value);
  return value;
}

async function currentOnboardingSession(client: ProductInitClient): Promise<OnboardingSession | null> {
  const value = await client.request("onboarding-status");
  return value === null ? null : sessionFrom(value);
}

function uniqueRequestId(prefix: string): string {
  return `${prefix}-${randomUUID().toUpperCase()}`;
}

function nextActionFor(session: OnboardingSession, profileMode = false): ProductInitResult["nextAction"] {
  if (session.status === "complete") return "complete";
  if (profileMode && session.currentStep === "claim-review") return "claim-review";
  return "continue-onboarding";
}

async function completeStep(
  client: ProductInitClient,
  session: OnboardingSession,
  step: ActionableOnboardingStep,
  evidence: unknown,
  conflictRetries = 0
): Promise<OnboardingSession> {
  if (session.currentStep !== step) return session;
  let result: unknown;
  try {
    result = await client.request("onboarding-complete-step", {
      expectedVersion: session.version,
      step,
      result: {
        outcome: "completed",
        resultPointer: redactedPointer(session, step),
        contentHash: sha256(stableStringify(evidence))
      }
    }, { requestId: requestId(session, `STEP-${step}`) });
  } catch (error) {
    const current = await currentOnboardingSession(client);
    if (current && current.currentStep !== step) return current;
    if (current && current.version > session.version && conflictRetries < MAX_ONBOARDING_CONFLICT_RETRIES) {
      const resumed = await resumeIfInterrupted(client, current);
      if (resumed.currentStep !== step) return resumed;
      if (resumed.status === "active") {
        return completeStep(client, resumed, step, evidence, conflictRetries + 1);
      }
    }
    throw error;
  }
  return await currentOnboardingSession(client) ?? sessionFrom(result);
}

function demoTwin(session: OnboardingSession): CareerTwin {
  return {
    twinId: `DEMO-TWIN-${session.sessionId.toUpperCase()}`,
    profileScope: "synthetic",
    twinVersion: 1,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
    facts: [],
    goals: [{
      goalId: "GOAL-DEMO-OPTIONALITY",
      label: "Test an evidence grounded career route while preserving optionality",
      horizon: "one-year",
      priority: 80,
      status: "active"
    }]
  };
}

async function putDemoProfile(client: ProductInitClient, session: OnboardingSession): Promise<string> {
  const twin = demoTwin(session);
  const record = await client.request("domain-put", {
    domain: "profiles",
    expectedVersion: 0,
    value: twin
  }, { requestId: requestId(session, "DOMAIN-PROFILE") }) as { recordId?: unknown };
  if (typeof record?.recordId !== "string") throw new Error("Demo profile write returned an invalid record");
  return record.recordId;
}

async function putDemoOpportunity(client: ProductInitClient, session: OnboardingSession): Promise<string> {
  const opportunity = createOpportunityRecord({
    source: "manual",
    sourceId: `ONBOARDING-${session.sessionId.toUpperCase()}`,
    sourceUrl: "https://example.test/vocation-os/demo-opportunity",
    applyUrl: "https://example.test/vocation-os/demo-opportunity/apply",
    company: "Synthetic Career Systems Lab",
    roleTitle: "Evidence Grounded Career Systems Researcher",
    locationText: "Remote worldwide",
    remotePolicy: "remote",
    applicantLocationRequirements: ["worldwide"],
    descriptionText: "A synthetic opportunity used to verify VocationOS onboarding, provenance, domain persistence, and discovery review.",
    postedAt: session.createdAt,
    capturedAt: session.createdAt,
    extractionConfidence: "high",
    sourcePayload: { fixture: "onboarding-v1" }
  });
  const record = await client.request("domain-put", {
    domain: "opportunities",
    expectedVersion: 0,
    value: opportunity
  }, { requestId: requestId(session, "DOMAIN-OPPORTUNITY") }) as { recordId?: unknown };
  if (typeof record?.recordId !== "string") throw new Error("Demo opportunity write returned an invalid record");
  return record.recordId;
}

async function resumeIfInterrupted(client: ProductInitClient, session: OnboardingSession): Promise<OnboardingSession> {
  if (session.status !== "failed" && session.status !== "cancelled") return session;
  if (session.currentStep === "complete") throw new Error("Terminal onboarding cannot be resumed");
  let result: unknown;
  try {
    result = await client.request("onboarding-resume", {
      expectedVersion: session.version,
      step: session.currentStep
    }, { requestId: uniqueRequestId(`REQ-INIT-${session.sessionId}-RESUME`) });
  } catch (error) {
    const current = await currentOnboardingSession(client);
    if (current && (current.version !== session.version || current.status === "active" || current.status === "complete")) {
      return current;
    }
    throw error;
  }
  return await currentOnboardingSession(client) ?? sessionFrom(result);
}

export async function runProductInitialization(
  client: ProductInitClient,
  options: ProductInitOptions
): Promise<ProductInitResult> {
  if (options.mode === "profile" && (!options.profilePath || options.profilePath.length === 0)) {
    throw new Error("Profile onboarding requires an absolute profile path");
  }
  const persistedSession = await currentOnboardingSession(client);
  let session = persistedSession === null
    ? sessionFrom(await client.request(
        "onboarding-start",
        {},
        { requestId: uniqueRequestId("REQ-INIT-PRIMARY-START") }
      ))
    : persistedSession;
  session = await currentOnboardingSession(client) ?? session;
  if (session.status === "complete") {
    return {
      mode: options.mode,
      session,
      artifactManifest: null,
      profileImportPlan: null,
      profileRecordId: null,
      opportunityRecordId: null,
      nextAction: "complete"
    };
  }
  session = await resumeIfInterrupted(client, session);
  if (options.mode === "resume") {
    session = await currentOnboardingSession(client) ?? session;
    return {
      mode: options.mode,
      session,
      artifactManifest: null,
      profileImportPlan: null,
      profileRecordId: null,
      opportunityRecordId: null,
      nextAction: nextActionFor(session)
    };
  }

  session = await completeStep(client, session, "runtime", { runtime: "vocationd", contract: 1 });
  session = await completeStep(client, session, "privacy", { storage: "local-encrypted", remoteEgress: false });

  let artifactManifest: unknown | null = null;
  let profileImportPlan: unknown | null = null;
  let profileRecordId: string | null = null;
  if (session.currentStep === "profile-import") {
    if (options.mode === "profile") {
      artifactManifest = await client.request(
        "artifact-import",
        { sourcePath: options.profilePath },
        { requestId: requestId(session, "ARTIFACT-PROFILE") }
      );
      profileImportPlan = await client.request(
        "profile-import-plan",
        { manifest: artifactManifest, format: profileFormat(options.profilePath ?? "") },
        { requestId: requestId(session, "PROFILE-IMPORT-PLAN") }
      );
      session = await completeStep(client, session, "profile-import", artifactManifest);
    } else {
      profileRecordId = await putDemoProfile(client, session);
      session = await completeStep(client, session, "profile-import", { profileRecordId });
    }
  }

  if (options.mode === "profile") {
    session = await currentOnboardingSession(client) ?? session;
    return {
      mode: options.mode,
      session,
      artifactManifest,
      profileImportPlan,
      profileRecordId: null,
      opportunityRecordId: null,
      nextAction: nextActionFor(session, true)
    };
  }

  session = await completeStep(client, session, "claim-review", { scope: "synthetic", reviewedClaims: 0 });
  session = await completeStep(client, session, "career-goals", { goalId: "GOAL-DEMO-OPTIONALITY" });
  session = await completeStep(client, session, "source-packs", { packs: ["manual", "local-fixture"] });
  session = await completeStep(client, session, "model-egress", { remoteEgress: false });
  let opportunityRecordId: string | null = null;
  if (session.currentStep === "first-discovery") {
    opportunityRecordId = await putDemoOpportunity(client, session);
    session = await completeStep(client, session, "first-discovery", { opportunityRecordId });
  }

  session = await currentOnboardingSession(client) ?? session;

  return {
    mode: options.mode,
    session,
    artifactManifest,
    profileImportPlan,
    profileRecordId,
    opportunityRecordId,
    nextAction: nextActionFor(session)
  };
}
