import { readFileSync } from "node:fs";
import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { sha256, stableStringify } from "./hash.js";

export const ONBOARDING_SCHEMA_VERSION = 2 as const;
export const ONBOARDING_MODES = ["demo", "profile"] as const;

export const ONBOARDING_STEPS = [
  "runtime",
  "privacy",
  "profile-import",
  "claim-review",
  "career-goals",
  "source-packs",
  "model-egress",
  "first-discovery",
  "complete"
] as const;

export const ONBOARDING_ACTIONABLE_STEPS = [
  "runtime",
  "privacy",
  "profile-import",
  "claim-review",
  "career-goals",
  "source-packs",
  "model-egress",
  "first-discovery"
] as const;

export const ONBOARDING_STATUSES = ["active", "failed", "cancelled", "complete"] as const;
export const ONBOARDING_STEP_OUTCOMES = ["completed", "skipped", "declined"] as const;
export const ONBOARDING_EVENT_TYPES = ["step-completed", "failed", "cancelled", "resumed"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingMode = (typeof ONBOARDING_MODES)[number];
export type ActionableOnboardingStep = (typeof ONBOARDING_ACTIONABLE_STEPS)[number];
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export type OnboardingStepOutcome = (typeof ONBOARDING_STEP_OUTCOMES)[number];
export type OnboardingEventType = (typeof ONBOARDING_EVENT_TYPES)[number];
export type Sha256Digest = `sha256:${string}`;
export type RedactedResultPointer = `redacted:${string}`;

export const ALLOWED_ONBOARDING_STEP_TRANSITIONS: Readonly<Record<OnboardingStep, readonly OnboardingStep[]>> = {
  runtime: ["privacy"],
  privacy: ["profile-import"],
  "profile-import": ["claim-review"],
  "claim-review": ["career-goals"],
  "career-goals": ["source-packs"],
  "source-packs": ["model-egress"],
  "model-egress": ["first-discovery"],
  "first-discovery": ["complete"],
  complete: []
};

export const ALLOWED_ONBOARDING_STATUS_TRANSITIONS: Readonly<Record<OnboardingStatus, readonly OnboardingStatus[]>> = {
  active: ["active", "failed", "cancelled", "complete"],
  failed: ["active"],
  cancelled: ["active"],
  complete: []
};

export interface OnboardingStepResultInput {
  outcome: OnboardingStepOutcome;
  resultPointer: RedactedResultPointer;
  contentHash: Sha256Digest;
  profilePlanHash?: Sha256Digest;
}

interface OnboardingCommandBase {
  operationId: string;
  expectedVersion: number;
  step: ActionableOnboardingStep;
  occurredAt: string;
}

export interface CompleteOnboardingStepCommand extends OnboardingCommandBase {
  result: OnboardingStepResultInput;
}

export interface InterruptOnboardingCommand extends OnboardingCommandBase {
  reasonCode: string;
  resultPointer: RedactedResultPointer;
}

export interface ResumeOnboardingCommand extends OnboardingCommandBase {}

export interface CreateOnboardingSessionInput {
  sessionId: string;
  createdAt: string;
  initializationMode: OnboardingMode;
}

interface OnboardingEventBase {
  eventType: OnboardingEventType;
  operationId: string;
  operationHash: Sha256Digest;
  version: number;
  step: ActionableOnboardingStep;
  occurredAt: string;
}

export interface OnboardingStepCompletedEvent extends OnboardingEventBase {
  eventType: "step-completed";
  nextStep: OnboardingStep;
  outcome: OnboardingStepOutcome;
  resultPointer: RedactedResultPointer;
  contentHash: Sha256Digest;
  profilePlanHash?: Sha256Digest;
  resultHash: Sha256Digest;
}

export interface OnboardingInterruptionEvent extends OnboardingEventBase {
  eventType: "failed" | "cancelled";
  reasonCode: string;
  resultPointer: RedactedResultPointer;
}

export interface OnboardingResumedEvent extends OnboardingEventBase {
  eventType: "resumed";
  resumedFrom: "failed" | "cancelled";
}

export type OnboardingEvent = OnboardingStepCompletedEvent | OnboardingInterruptionEvent | OnboardingResumedEvent;

export interface OnboardingSession {
  schemaVersion: typeof ONBOARDING_SCHEMA_VERSION;
  sessionId: string;
  initializationMode: OnboardingMode;
  profilePlanHash: Sha256Digest | null;
  version: number;
  status: OnboardingStatus;
  currentStep: OnboardingStep;
  events: OnboardingEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingValidationResult {
  valid: boolean;
  errors: string[];
}

export type OnboardingErrorCode =
  | "validation"
  | "stale-version"
  | "replay-mismatch"
  | "invalid-transition"
  | "terminal-state";

export class OnboardingStateMachineError extends Error {
  readonly code: OnboardingErrorCode;

  constructor(code: OnboardingErrorCode, message: string) {
    super(message);
    this.name = "OnboardingStateMachineError";
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REDACTED_POINTER_PATTERN = /^redacted:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,7}$/;
const ONBOARDING_SCHEMA_URL = new URL("../schemas/onboarding-session.schema.json", import.meta.url);

let cachedSessionValidator: ValidateFunction | null = null;

function validationError(message: string): OnboardingStateMachineError {
  return new OnboardingStateMachineError("validation", message);
}

function getSessionValidator(): ValidateFunction {
  if (cachedSessionValidator) return cachedSessionValidator;

  const ajv = new Ajv({ allErrors: true, strict: true });
  const formatsModule = addFormatsModule as unknown as { default?: (instance: Ajv) => void };
  const applyFormats = formatsModule.default ?? (addFormatsModule as unknown as (instance: Ajv) => void);
  applyFormats(ajv);

  const schema = JSON.parse(readFileSync(ONBOARDING_SCHEMA_URL, "utf8")) as AnySchema;
  cachedSessionValidator = ajv.compile(schema);
  return cachedSessionValidator;
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: unknown, expectedKeys: readonly string[], context: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw validationError(`${context} must be a plain object`);
  }

  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(value);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  const unexpected = actualKeys.filter((key) => !expected.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : null,
      unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : null
    ].filter((detail): detail is string => detail !== null);
    throw validationError(`${context} has invalid fields: ${details.join("; ")}`);
  }
}

function assertCanonicalUuid(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw validationError(`${context} must be a canonical lowercase UUID`);
  }
}

function assertSha256(value: unknown, context: string): asserts value is Sha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw validationError(`${context} must be a canonical SHA-256 digest`);
  }
}

function assertRedactedPointer(value: unknown, context: string): asserts value is RedactedResultPointer {
  if (typeof value !== "string" || !REDACTED_POINTER_PATTERN.test(value)) {
    throw validationError(`${context} must be an opaque redacted UUID pointer`);
  }
}

function assertTimestamp(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    throw validationError(`${context} must be a canonical UTC timestamp with milliseconds`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw validationError(`${context} must be a valid UTC timestamp`);
  }
}

function assertVersion(value: unknown, context: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw validationError(`${context} must be a non-negative safe integer`);
  }
}

function assertActionableStep(value: unknown, context: string): asserts value is ActionableOnboardingStep {
  if (typeof value !== "string" || !(ONBOARDING_ACTIONABLE_STEPS as readonly string[]).includes(value)) {
    throw validationError(`${context} must be an actionable onboarding step`);
  }
}

function assertStepOutcome(value: unknown, context: string): asserts value is OnboardingStepOutcome {
  if (typeof value !== "string" || !(ONBOARDING_STEP_OUTCOMES as readonly string[]).includes(value)) {
    throw validationError(`${context} must be a supported onboarding outcome`);
  }
}

function assertOnboardingMode(value: unknown, context: string): asserts value is OnboardingMode {
  if (typeof value !== "string" || !(ONBOARDING_MODES as readonly string[]).includes(value)) {
    throw validationError(`${context} must be demo or profile`);
  }
}

function assertReasonCode(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !REASON_CODE_PATTERN.test(value)) {
    throw validationError(`${context} must be a bounded machine reason code`);
  }
}

function assertCommandBase(command: OnboardingCommandBase): void {
  assertCanonicalUuid(command.operationId, "operationId");
  assertVersion(command.expectedVersion, "expectedVersion");
  assertActionableStep(command.step, "step");
  assertTimestamp(command.occurredAt, "occurredAt");
}

function assertStepResult(result: OnboardingStepResultInput): void {
  assertExactKeys(
    result,
    result.profilePlanHash === undefined
      ? ["outcome", "resultPointer", "contentHash"]
      : ["outcome", "resultPointer", "contentHash", "profilePlanHash"],
    "step result"
  );
  assertStepOutcome(result.outcome, "step result outcome");
  assertRedactedPointer(result.resultPointer, "step result pointer");
  assertSha256(result.contentHash, "step result contentHash");
  if (result.profilePlanHash !== undefined) assertSha256(result.profilePlanHash, "step result profilePlanHash");
}

function assertProfilePlanBinding(
  mode: OnboardingMode,
  step: ActionableOnboardingStep,
  profilePlanHash: Sha256Digest | undefined
): void {
  if (step === "profile-import" && mode === "profile" && profilePlanHash === undefined) {
    throw validationError("profile onboarding requires a bound profile plan hash");
  }
  if ((step !== "profile-import" || mode === "demo") && profilePlanHash !== undefined) {
    throw validationError("profilePlanHash is only valid for profile import in profile mode");
  }
}

function assertTimestampIsMonotonic(session: OnboardingSession, occurredAt: string): void {
  if (Date.parse(occurredAt) < Date.parse(session.updatedAt)) {
    throw validationError(`occurredAt ${occurredAt} precedes session updatedAt ${session.updatedAt}`);
  }
}

function operationHash(operation: string, payload: Record<string, unknown>): Sha256Digest {
  return sha256(stableStringify({
    ...payload,
    operation,
    schemaVersion: ONBOARDING_SCHEMA_VERSION
  })) as Sha256Digest;
}

export function computeOnboardingStepResultHash(
  step: ActionableOnboardingStep,
  result: OnboardingStepResultInput
): Sha256Digest {
  assertActionableStep(step, "step");
  assertStepResult(result);
  return sha256(stableStringify({
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    step,
    outcome: result.outcome,
    resultPointer: result.resultPointer,
    contentHash: result.contentHash,
    ...(result.profilePlanHash !== undefined ? { profilePlanHash: result.profilePlanHash } : {})
  })) as Sha256Digest;
}

function completeStepOperationHash(step: ActionableOnboardingStep, resultHash: Sha256Digest): Sha256Digest {
  return operationHash("complete-step", { step, resultHash });
}

function interruptionOperationHash(
  eventType: "failed" | "cancelled",
  step: ActionableOnboardingStep,
  reasonCode: string,
  resultPointer: RedactedResultPointer
): Sha256Digest {
  return operationHash(eventType, { step, reasonCode, resultPointer });
}

function resumeOperationHash(step: ActionableOnboardingStep): Sha256Digest {
  return operationHash("resume", { step });
}

export function getNextOnboardingStep(step: ActionableOnboardingStep): OnboardingStep {
  const transitions = ALLOWED_ONBOARDING_STEP_TRANSITIONS[step];
  const nextStep = transitions[0];
  if (!nextStep || transitions.length !== 1) {
    throw new OnboardingStateMachineError("invalid-transition", `Step ${step} does not have one deterministic successor`);
  }
  return nextStep;
}

function assertAllowedStepTransition(from: OnboardingStep, to: OnboardingStep): void {
  if (!ALLOWED_ONBOARDING_STEP_TRANSITIONS[from].includes(to)) {
    throw new OnboardingStateMachineError("invalid-transition", `Onboarding step transition ${from} -> ${to} is not allowed`);
  }
}

function assertAllowedStatusTransition(from: OnboardingStatus, to: OnboardingStatus): void {
  if (!ALLOWED_ONBOARDING_STATUS_TRANSITIONS[from].includes(to)) {
    throw new OnboardingStateMachineError("invalid-transition", `Onboarding status transition ${from} -> ${to} is not allowed`);
  }
}

interface OnboardingProjection {
  version: number;
  status: OnboardingStatus;
  currentStep: OnboardingStep;
  profilePlanHash: Sha256Digest | null;
  updatedAt: string;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function projectEvents(session: OnboardingSession): OnboardingProjection {
  let version = 0;
  let status: OnboardingStatus = "active";
  let currentStep: OnboardingStep = "runtime";
  let profilePlanHash: Sha256Digest | null = null;
  let updatedAt = session.createdAt;
  const operationIds = new Set<string>();

  for (const [index, event] of session.events.entries()) {
    invariant(event.version === index + 1, `event ${index} has non-contiguous version ${event.version}`);
    invariant(event.version === version + 1, `event ${index} does not follow aggregate version ${version}`);
    invariant(!operationIds.has(event.operationId), `operationId ${event.operationId} is duplicated`);
    invariant(Date.parse(event.occurredAt) >= Date.parse(updatedAt), `event ${index} timestamp moves backwards`);
    invariant(event.step === currentStep, `event ${index} targets ${event.step} while current step is ${currentStep}`);
    operationIds.add(event.operationId);

    switch (event.eventType) {
      case "step-completed": {
        invariant(status === "active", `event ${index} completes a step while status is ${status}`);
        const nextStep = getNextOnboardingStep(event.step);
        invariant(event.nextStep === nextStep, `event ${index} has next step ${event.nextStep}, expected ${nextStep}`);
        assertAllowedStepTransition(currentStep, nextStep);
        assertProfilePlanBinding(session.initializationMode, event.step, event.profilePlanHash);
        const resultHash = computeOnboardingStepResultHash(event.step, {
          outcome: event.outcome,
          resultPointer: event.resultPointer,
          contentHash: event.contentHash,
          ...(event.profilePlanHash !== undefined ? { profilePlanHash: event.profilePlanHash } : {})
        });
        invariant(event.resultHash === resultHash, `event ${index} resultHash does not match its sanitized result`);
        invariant(
          event.operationHash === completeStepOperationHash(event.step, resultHash),
          `event ${index} operationHash does not match its completion request`
        );
        const nextStatus: OnboardingStatus = nextStep === "complete" ? "complete" : "active";
        assertAllowedStatusTransition(status, nextStatus);
        currentStep = nextStep;
        status = nextStatus;
        if (event.step === "profile-import") profilePlanHash = event.profilePlanHash ?? null;
        break;
      }
      case "failed":
      case "cancelled": {
        invariant(status === "active", `event ${index} interrupts a session while status is ${status}`);
        invariant(
          event.operationHash === interruptionOperationHash(event.eventType, event.step, event.reasonCode, event.resultPointer),
          `event ${index} operationHash does not match its interruption request`
        );
        assertAllowedStatusTransition(status, event.eventType);
        status = event.eventType;
        break;
      }
      case "resumed": {
        invariant(status === "failed" || status === "cancelled", `event ${index} resumes a session while status is ${status}`);
        invariant(event.resumedFrom === status, `event ${index} resumedFrom does not match status ${status}`);
        invariant(event.operationHash === resumeOperationHash(event.step), `event ${index} operationHash does not match its resume request`);
        assertAllowedStatusTransition(status, "active");
        status = "active";
        break;
      }
    }

    version = event.version;
    updatedAt = event.occurredAt;
  }

  return { version, status, currentStep, profilePlanHash, updatedAt };
}

function validateProjection(session: OnboardingSession): string[] {
  try {
    const projection = projectEvents(session);
    const errors: string[] = [];
    if (session.version !== projection.version) errors.push(`/version is ${session.version}, projected ${projection.version}`);
    if (session.status !== projection.status) errors.push(`/status is ${session.status}, projected ${projection.status}`);
    if (session.currentStep !== projection.currentStep) {
      errors.push(`/currentStep is ${session.currentStep}, projected ${projection.currentStep}`);
    }
    if (session.profilePlanHash !== projection.profilePlanHash) {
      errors.push(`/profilePlanHash is ${String(session.profilePlanHash)}, projected ${String(projection.profilePlanHash)}`);
    }
    if (session.updatedAt !== projection.updatedAt) errors.push(`/updatedAt is ${session.updatedAt}, projected ${projection.updatedAt}`);
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function validateOnboardingSession(value: unknown): OnboardingValidationResult {
  const validator = getSessionValidator();
  if (!validator(value)) return { valid: false, errors: formatSchemaErrors(validator.errors) };

  const projectionErrors = validateProjection(value as OnboardingSession);
  return { valid: projectionErrors.length === 0, errors: projectionErrors };
}

export function assertOnboardingSession(value: unknown): asserts value is OnboardingSession {
  const result = validateOnboardingSession(value);
  if (!result.valid) {
    throw validationError(`Onboarding session validation failed: ${result.errors.join("; ")}`);
  }
}

function validated(session: OnboardingSession): OnboardingSession {
  assertOnboardingSession(session);
  return session;
}

export function createOnboardingSession(input: CreateOnboardingSessionInput): OnboardingSession {
  assertExactKeys(input, ["sessionId", "createdAt", "initializationMode"], "create onboarding input");
  assertCanonicalUuid(input.sessionId, "sessionId");
  assertTimestamp(input.createdAt, "createdAt");
  assertOnboardingMode(input.initializationMode, "initializationMode");

  return validated({
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    sessionId: input.sessionId,
    initializationMode: input.initializationMode,
    profilePlanHash: null,
    version: 0,
    status: "active",
    currentStep: "runtime",
    events: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

function replayOrThrow(
  session: OnboardingSession,
  operationId: string,
  expectedOperationHash: Sha256Digest
): OnboardingSession | null {
  const existing = session.events.find((event) => event.operationId === operationId);
  if (!existing) return null;
  if (existing.operationHash !== expectedOperationHash) {
    throw new OnboardingStateMachineError(
      "replay-mismatch",
      `Operation ${operationId} was already recorded with a different request hash`
    );
  }
  return session;
}

function assertMutable(session: OnboardingSession): void {
  if (session.status === "complete") {
    throw new OnboardingStateMachineError(
      "terminal-state",
      `Onboarding session ${session.sessionId} is complete and cannot be changed`
    );
  }
}

function assertExpectedVersion(session: OnboardingSession, expectedVersion: number): void {
  if (session.version !== expectedVersion) {
    throw new OnboardingStateMachineError(
      "stale-version",
      `Stale onboarding version: expected ${expectedVersion}, current ${session.version}`
    );
  }
}

function assertCurrentStep(session: OnboardingSession, step: ActionableOnboardingStep): void {
  if (session.currentStep !== step) {
    throw new OnboardingStateMachineError(
      "invalid-transition",
      `Out-of-order onboarding step: expected ${session.currentStep}, received ${step}`
    );
  }
}

function assertActive(session: OnboardingSession, operation: string): void {
  if (session.status !== "active") {
    throw new OnboardingStateMachineError(
      "invalid-transition",
      `Onboarding session is ${session.status} and must be resumed before ${operation}`
    );
  }
}

function appendEvent(
  session: OnboardingSession,
  event: OnboardingEvent,
  status: OnboardingStatus,
  currentStep: OnboardingStep
): OnboardingSession {
  return validated({
    ...session,
    version: event.version,
    status,
    currentStep,
    profilePlanHash: event.eventType === "step-completed" && event.step === "profile-import"
      ? event.profilePlanHash ?? null
      : session.profilePlanHash,
    events: [...session.events, event],
    updatedAt: event.occurredAt
  });
}

export function completeOnboardingStep(
  session: OnboardingSession,
  command: CompleteOnboardingStepCommand
): OnboardingSession {
  assertOnboardingSession(session);
  assertExactKeys(command, ["operationId", "expectedVersion", "step", "occurredAt", "result"], "complete step command");
  assertCommandBase(command);
  assertStepResult(command.result);
  assertProfilePlanBinding(session.initializationMode, command.step, command.result.profilePlanHash);

  const resultHash = computeOnboardingStepResultHash(command.step, command.result);
  const requestHash = completeStepOperationHash(command.step, resultHash);
  const replayed = replayOrThrow(session, command.operationId, requestHash);
  if (replayed) return replayed;

  assertMutable(session);
  assertExpectedVersion(session, command.expectedVersion);
  assertActive(session, "completing a step");
  assertCurrentStep(session, command.step);
  assertTimestampIsMonotonic(session, command.occurredAt);

  const nextStep = getNextOnboardingStep(command.step);
  assertAllowedStepTransition(command.step, nextStep);
  const nextStatus: OnboardingStatus = nextStep === "complete" ? "complete" : "active";
  assertAllowedStatusTransition(session.status, nextStatus);
  const event: OnboardingStepCompletedEvent = {
    eventType: "step-completed",
    operationId: command.operationId,
    operationHash: requestHash,
    version: session.version + 1,
    step: command.step,
    occurredAt: command.occurredAt,
    nextStep,
    outcome: command.result.outcome,
    resultPointer: command.result.resultPointer,
    contentHash: command.result.contentHash,
    ...(command.result.profilePlanHash !== undefined ? { profilePlanHash: command.result.profilePlanHash } : {}),
    resultHash
  };
  return appendEvent(session, event, nextStatus, nextStep);
}

function interruptOnboarding(
  session: OnboardingSession,
  command: InterruptOnboardingCommand,
  eventType: "failed" | "cancelled"
): OnboardingSession {
  assertOnboardingSession(session);
  assertExactKeys(
    command,
    ["operationId", "expectedVersion", "step", "occurredAt", "reasonCode", "resultPointer"],
    `${eventType} command`
  );
  assertCommandBase(command);
  assertReasonCode(command.reasonCode, "reasonCode");
  assertRedactedPointer(command.resultPointer, "resultPointer");

  const requestHash = interruptionOperationHash(eventType, command.step, command.reasonCode, command.resultPointer);
  const replayed = replayOrThrow(session, command.operationId, requestHash);
  if (replayed) return replayed;

  assertMutable(session);
  assertExpectedVersion(session, command.expectedVersion);
  assertActive(session, `${eventType === "failed" ? "failing" : "cancelling"} the session`);
  assertCurrentStep(session, command.step);
  assertTimestampIsMonotonic(session, command.occurredAt);
  assertAllowedStatusTransition(session.status, eventType);

  const event: OnboardingInterruptionEvent = {
    eventType,
    operationId: command.operationId,
    operationHash: requestHash,
    version: session.version + 1,
    step: command.step,
    occurredAt: command.occurredAt,
    reasonCode: command.reasonCode,
    resultPointer: command.resultPointer
  };
  return appendEvent(session, event, eventType, session.currentStep);
}

export function failOnboarding(session: OnboardingSession, command: InterruptOnboardingCommand): OnboardingSession {
  return interruptOnboarding(session, command, "failed");
}

export function cancelOnboarding(session: OnboardingSession, command: InterruptOnboardingCommand): OnboardingSession {
  return interruptOnboarding(session, command, "cancelled");
}

export function resumeOnboarding(session: OnboardingSession, command: ResumeOnboardingCommand): OnboardingSession {
  assertOnboardingSession(session);
  assertExactKeys(command, ["operationId", "expectedVersion", "step", "occurredAt"], "resume command");
  assertCommandBase(command);

  const requestHash = resumeOperationHash(command.step);
  const replayed = replayOrThrow(session, command.operationId, requestHash);
  if (replayed) return replayed;

  assertMutable(session);
  assertExpectedVersion(session, command.expectedVersion);
  if (session.status !== "failed" && session.status !== "cancelled") {
    throw new OnboardingStateMachineError(
      "invalid-transition",
      `Only failed or cancelled onboarding can resume, found ${session.status}`
    );
  }
  assertCurrentStep(session, command.step);
  assertTimestampIsMonotonic(session, command.occurredAt);
  assertAllowedStatusTransition(session.status, "active");

  const event: OnboardingResumedEvent = {
    eventType: "resumed",
    operationId: command.operationId,
    operationHash: requestHash,
    version: session.version + 1,
    step: command.step,
    occurredAt: command.occurredAt,
    resumedFrom: session.status
  };
  return appendEvent(session, event, "active", session.currentStep);
}

export function isOnboardingTerminal(session: OnboardingSession): boolean {
  assertOnboardingSession(session);
  return session.status === "complete";
}

export function completedOnboardingSteps(session: OnboardingSession): ActionableOnboardingStep[] {
  assertOnboardingSession(session);
  return session.events
    .filter((event): event is OnboardingStepCompletedEvent => event.eventType === "step-completed")
    .map((event) => event.step);
}
