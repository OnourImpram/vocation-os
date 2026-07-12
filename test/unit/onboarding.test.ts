import { describe, expect, it } from "vitest";
import {
  ONBOARDING_ACTIONABLE_STEPS,
  OnboardingStateMachineError,
  cancelOnboarding,
  completeOnboardingStep,
  completedOnboardingSteps,
  computeOnboardingStepResultHash,
  createOnboardingSession,
  failOnboarding,
  isOnboardingTerminal,
  resumeOnboarding,
  validateOnboardingSession,
  type ActionableOnboardingStep,
  type CompleteOnboardingStepCommand,
  type InterruptOnboardingCommand,
  type OnboardingSession,
  type OnboardingStepOutcome,
  type OnboardingStepResultInput,
  type RedactedResultPointer,
  type ResumeOnboardingCommand,
  type Sha256Digest
} from "../../src/onboarding.js";

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString().padStart(12, "0")}`;
}

function digest(seed: number): Sha256Digest {
  return `sha256:${seed.toString(16).padStart(64, "0")}`;
}

function pointer(seed: number): RedactedResultPointer {
  return `redacted:${uuid(seed)}`;
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 6, 11, 12, 0, offsetSeconds)).toISOString();
}

function freshSession(): OnboardingSession {
  return createOnboardingSession({
    sessionId: uuid(1),
    createdAt: timestamp(0)
  });
}

function result(seed: number, outcome: OnboardingStepOutcome = "completed"): OnboardingStepResultInput {
  return {
    outcome,
    resultPointer: pointer(100 + seed),
    contentHash: digest(200 + seed)
  };
}

function completionCommand(
  session: OnboardingSession,
  step: ActionableOnboardingStep,
  seed: number,
  outcome: OnboardingStepOutcome = "completed"
): CompleteOnboardingStepCommand {
  return {
    operationId: uuid(300 + seed),
    expectedVersion: session.version,
    step,
    occurredAt: timestamp(seed),
    result: result(seed, outcome)
  };
}

function interruptionCommand(
  session: OnboardingSession,
  step: ActionableOnboardingStep,
  seed: number,
  reasonCode: string
): InterruptOnboardingCommand {
  return {
    operationId: uuid(500 + seed),
    expectedVersion: session.version,
    step,
    occurredAt: timestamp(seed),
    reasonCode,
    resultPointer: pointer(600 + seed)
  };
}

function resumeCommand(session: OnboardingSession, step: ActionableOnboardingStep, seed: number): ResumeOnboardingCommand {
  return {
    operationId: uuid(700 + seed),
    expectedVersion: session.version,
    step,
    occurredAt: timestamp(seed)
  };
}

function machineError(action: () => unknown): OnboardingStateMachineError {
  try {
    action();
  } catch (error) {
    if (error instanceof OnboardingStateMachineError) return error;
    throw error;
  }
  throw new Error("Expected an OnboardingStateMachineError");
}

function completeHappyPath(): { session: OnboardingSession; commands: CompleteOnboardingStepCommand[] } {
  let session = freshSession();
  const commands: CompleteOnboardingStepCommand[] = [];
  for (const [index, step] of ONBOARDING_ACTIONABLE_STEPS.entries()) {
    const outcome: OnboardingStepOutcome = step === "model-egress" ? "declined" : "completed";
    const command = completionCommand(session, step, index + 1, outcome);
    commands.push(command);
    session = completeOnboardingStep(session, command);
  }
  return { session, commands };
}

describe("resumable onboarding state machine", () => {
  it("completes the required path in order with deterministic result hashes", () => {
    const { session } = completeHappyPath();

    expect(session.status).toBe("complete");
    expect(session.currentStep).toBe("complete");
    expect(session.version).toBe(ONBOARDING_ACTIONABLE_STEPS.length);
    expect(completedOnboardingSteps(session)).toEqual(ONBOARDING_ACTIONABLE_STEPS);
    expect(isOnboardingTerminal(session)).toBe(true);
    expect(validateOnboardingSession(session)).toEqual({ valid: true, errors: [] });

    for (const event of session.events) {
      expect(event.eventType).toBe("step-completed");
      if (event.eventType !== "step-completed") continue;
      expect(event.resultHash).toBe(
        computeOnboardingStepResultHash(event.step, {
          outcome: event.outcome,
          resultPointer: event.resultPointer,
          contentHash: event.contentHash
        })
      );
    }
  });

  it("resumes a failed session from persisted JSON without losing its current step", () => {
    const initial = freshSession();
    const runtimeComplete = completeOnboardingStep(initial, completionCommand(initial, "runtime", 1));
    const failed = failOnboarding(runtimeComplete, interruptionCommand(runtimeComplete, "privacy", 2, "profile-source-unavailable"));
    const restored = JSON.parse(JSON.stringify(failed)) as OnboardingSession;
    const resumed = resumeOnboarding(restored, resumeCommand(restored, "privacy", 3));
    const continued = completeOnboardingStep(resumed, completionCommand(resumed, "privacy", 4));

    expect(failed.status).toBe("failed");
    expect(resumed.status).toBe("active");
    expect(resumed.currentStep).toBe("privacy");
    expect(continued.currentStep).toBe("profile-import");
    expect(continued.events.map((event) => event.eventType)).toEqual([
      "step-completed",
      "failed",
      "resumed",
      "step-completed"
    ]);
    expect(validateOnboardingSession(continued).valid).toBe(true);
  });

  it("returns the unchanged aggregate for an exact idempotent replay before stale version checks", () => {
    const initial = freshSession();
    const initialSnapshot = JSON.parse(JSON.stringify(initial)) as OnboardingSession;
    const command = completionCommand(initial, "runtime", 1);
    const advanced = completeOnboardingStep(initial, command);
    const replayed = completeOnboardingStep(advanced, command);

    expect(initial).toEqual(initialSnapshot);
    expect(replayed).toBe(advanced);
    expect(replayed.version).toBe(1);
    expect(replayed.events).toHaveLength(1);
  });

  it("applies idempotent replay consistently to interruption and resume commands", () => {
    const initial = freshSession();
    const failureCommand = interruptionCommand(initial, "runtime", 1, "runtime-preflight-failed");
    const failed = failOnboarding(initial, failureCommand);
    expect(failOnboarding(failed, failureCommand)).toBe(failed);

    const recoveryCommand = resumeCommand(failed, "runtime", 2);
    const resumed = resumeOnboarding(failed, recoveryCommand);
    expect(resumeOnboarding(resumed, recoveryCommand)).toBe(resumed);

    const cancellationCommand = interruptionCommand(resumed, "runtime", 3, "user-cancelled");
    const cancelled = cancelOnboarding(resumed, cancellationCommand);
    expect(cancelOnboarding(cancelled, cancellationCommand)).toBe(cancelled);
    expect(cancelled.version).toBe(3);
    expect(cancelled.events).toHaveLength(3);
  });

  it("rejects operation ID replay when the sanitized result differs", () => {
    const initial = freshSession();
    const command = completionCommand(initial, "runtime", 1);
    const advanced = completeOnboardingStep(initial, command);
    const mismatch: CompleteOnboardingStepCommand = {
      ...command,
      result: {
        ...command.result,
        contentHash: digest(999)
      }
    };

    const error = machineError(() => completeOnboardingStep(advanced, mismatch));
    expect(error.code).toBe("replay-mismatch");
    expect(error.message).toContain("different request hash");
  });

  it("rejects an out-of-order step even at the current version", () => {
    const session = freshSession();
    const command = completionCommand(session, "privacy", 1);

    const error = machineError(() => completeOnboardingStep(session, command));
    expect(error.code).toBe("invalid-transition");
    expect(error.message).toContain("expected runtime, received privacy");
  });

  it("rejects a new command carrying a stale optimistic concurrency version", () => {
    const session = freshSession();
    const command = {
      ...completionCommand(session, "runtime", 1),
      expectedVersion: 4
    };

    const error = machineError(() => completeOnboardingStep(session, command));
    expect(error.code).toBe("stale-version");
    expect(error.message).toContain("expected 4, current 0");
  });

  it("records a recoverable failure and blocks step completion until resume", () => {
    const session = freshSession();
    const failed = failOnboarding(session, interruptionCommand(session, "runtime", 1, "runtime-preflight-failed"));

    expect(failed.status).toBe("failed");
    expect(failed.currentStep).toBe("runtime");
    expect(failed.version).toBe(1);
    expect(failed.events[0]).toMatchObject({
      eventType: "failed",
      reasonCode: "runtime-preflight-failed",
      resultPointer: pointer(601)
    });

    const error = machineError(() => completeOnboardingStep(failed, completionCommand(failed, "runtime", 2)));
    expect(error.code).toBe("invalid-transition");
    expect(error.message).toContain("must be resumed");
  });

  it("records cancellation as resumable and resumes only the interrupted step", () => {
    const session = freshSession();
    const cancelled = cancelOnboarding(session, interruptionCommand(session, "runtime", 1, "user-cancelled"));
    const resumed = resumeOnboarding(cancelled, resumeCommand(cancelled, "runtime", 2));

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.currentStep).toBe("runtime");
    expect(resumed.status).toBe("active");
    expect(resumed.currentStep).toBe("runtime");
    expect(resumed.version).toBe(2);
    expect(resumed.events.at(-1)).toMatchObject({ eventType: "resumed", resumedFrom: "cancelled" });
  });

  it("protects terminal state while permitting an exact final-command replay", () => {
    const { session, commands } = completeHappyPath();
    const finalCommand = commands.at(-1);
    if (!finalCommand) throw new Error("Happy path did not produce a final command");

    expect(completeOnboardingStep(session, finalCommand)).toBe(session);

    const newCompletion = completionCommand(session, "first-discovery", 20);
    const completionError = machineError(() => completeOnboardingStep(session, newCompletion));
    const failureError = machineError(() =>
      failOnboarding(session, interruptionCommand(session, "first-discovery", 21, "late-failure"))
    );
    const cancellationError = machineError(() =>
      cancelOnboarding(session, interruptionCommand(session, "first-discovery", 22, "late-cancellation"))
    );
    const resumeError = machineError(() => resumeOnboarding(session, resumeCommand(session, "first-discovery", 23)));

    expect([completionError.code, failureError.code, cancellationError.code, resumeError.code]).toEqual([
      "terminal-state",
      "terminal-state",
      "terminal-state",
      "terminal-state"
    ]);
  });

  it("rejects illegal resume, repeated interruption, and timestamp rollback", () => {
    const initial = freshSession();
    const resumeError = machineError(() => resumeOnboarding(initial, resumeCommand(initial, "runtime", 1)));
    expect(resumeError.code).toBe("invalid-transition");

    const failed = failOnboarding(initial, interruptionCommand(initial, "runtime", 1, "runtime-preflight-failed"));
    const repeatedInterruption = machineError(() =>
      cancelOnboarding(failed, interruptionCommand(failed, "runtime", 2, "user-cancelled"))
    );
    expect(repeatedInterruption.code).toBe("invalid-transition");

    const advanced = completeOnboardingStep(initial, completionCommand(initial, "runtime", 1));
    const backwards = {
      ...completionCommand(advanced, "privacy", 2),
      occurredAt: timestamp(0)
    };
    const timestampError = machineError(() => completeOnboardingStep(advanced, backwards));
    expect(timestampError.code).toBe("validation");
    expect(timestampError.message).toContain("precedes session updatedAt");
  });

  it("detects projection, transition, version, and operation identity forgeries", () => {
    const initial = freshSession();
    const advanced = completeOnboardingStep(initial, completionCommand(initial, "runtime", 1));
    const projectionForgery = {
      ...advanced,
      version: 4,
      status: "failed",
      currentStep: "career-goals",
      updatedAt: timestamp(8)
    };
    const projectionValidation = validateOnboardingSession(projectionForgery);
    expect(projectionValidation.valid).toBe(false);
    expect(projectionValidation.errors.join(" ")).toContain("projected");

    const versionForgery = {
      ...advanced,
      version: 2,
      events: advanced.events.map((event) => ({ ...event, version: 2 }))
    };
    expect(validateOnboardingSession(versionForgery).errors.join(" ")).toContain("non-contiguous version");

    const transitionForgery = {
      ...advanced,
      currentStep: "source-packs",
      events: advanced.events.map((event) => event.eventType === "step-completed"
        ? { ...event, nextStep: "source-packs" }
        : event)
    };
    expect(validateOnboardingSession(transitionForgery).errors.join(" ")).toContain("expected privacy");

    const continued = completeOnboardingStep(advanced, completionCommand(advanced, "privacy", 2));
    const firstOperationId = continued.events[0]?.operationId;
    if (!firstOperationId) throw new Error("Expected a first onboarding event");
    const duplicateOperation = {
      ...continued,
      events: continued.events.map((event, index) => index === 1 ? { ...event, operationId: firstOperationId } : event)
    };
    expect(validateOnboardingSession(duplicateOperation).errors.join(" ")).toContain("duplicated");
  });

  it("rejects raw result fields and detects persisted event tampering at runtime", () => {
    const session = freshSession();
    const command = completionCommand(session, "runtime", 1);
    const rawCommand = {
      ...command,
      result: {
        ...command.result,
        rawPayload: { value: "not-storable" }
      }
    } as unknown as CompleteOnboardingStepCommand;

    const rawFieldError = machineError(() => completeOnboardingStep(session, rawCommand));
    expect(rawFieldError.code).toBe("validation");
    expect(rawFieldError.message).toContain("unexpected rawPayload");

    const advanced = completeOnboardingStep(session, command);
    const storedRawEvent = {
      ...advanced,
      events: advanced.events.map((event, index) => index === 0 ? { ...event, rawPayload: "not-storable" } : event)
    };
    const rawEventValidation = validateOnboardingSession(storedRawEvent);
    expect(rawEventValidation.valid).toBe(false);
    expect(rawEventValidation.errors.join(" ")).toContain("additional properties");

    const tampered = {
      ...advanced,
      events: advanced.events.map((event, index) => index === 0 ? { ...event, operationHash: digest(999) } : event)
    };
    const validation = validateOnboardingSession(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("operationHash does not match");
  });
});
