import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ fork: forkMock }));

import { parseProfileArtifact } from "../../src/import/profile-import.js";

class SpawnFailureChild extends EventEmitter {
  public readonly stderr = new EventEmitter();
  public connected = true;

  public send(_message?: unknown, _callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => {
      this.emit("error", new Error("private executable path must not escape"));
      this.emit("close", -1, null);
    });
    return true;
  }

  public kill(): boolean {
    return true;
  }

  public disconnect(): void {
    this.connected = false;
  }
}

class SendFailureChild extends SpawnFailureChild {
  public override send(_message?: unknown, callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => callback?.(new Error("private IPC diagnostics must not escape")));
    return true;
  }
}

class LateSuccessChild extends SpawnFailureChild {
  public readonly killSignals: string[] = [];

  public override send(_message?: unknown, _callback?: (error: Error | null) => void): boolean {
    return true;
  }

  public override kill(signal?: string): boolean {
    this.killSignals.push(signal ?? "default");
    return true;
  }

  public emitSuccess(): void {
    this.emit("message", {
      type: "profile-parsed",
      result: { format: "text", text: "late success must be ignored", pageCount: null, warnings: [] }
    });
  }
}

class ImmediateSuccessChild extends LateSuccessChild {
  public override send(): boolean {
    queueMicrotask(() => this.emitSuccess());
    return true;
  }
}

describe("profile parser process lifecycle", () => {
  beforeEach(() => {
    forkMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles promptly and sanitizes diagnostics when the parser cannot spawn", async () => {
    forkMock.mockReturnValue(new SpawnFailureChild());
    const result = parseProfileArtifact(Buffer.from("bounded profile text", "utf8"), "text");

    await expect(result).rejects.toThrow("Profile parser process could not be started");
    await expect(result).rejects.not.toThrow("private executable path");
  });

  it("settles and sanitizes diagnostics when the initial IPC request cannot be delivered", async () => {
    forkMock.mockReturnValue(new SendFailureChild());

    await expect(parseProfileArtifact(Buffer.from("bounded profile text", "utf8"), "text"))
      .rejects.toThrow("Profile parser request could not be delivered");
  });

  it("rejects a late success and preserves forced termination after timeout", async () => {
    vi.useFakeTimers();
    const child = new LateSuccessChild();
    forkMock.mockReturnValue(child);
    const result = parseProfileArtifact(Buffer.from("bounded profile text", "utf8"), "text");
    const rejection = expect(result).rejects.toThrow("exceeded its 30 second time limit");

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    child.emitSuccess();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("forces termination when a successful parser child does not close", async () => {
    vi.useFakeTimers();
    const child = new ImmediateSuccessChild();
    forkMock.mockReturnValue(child);
    const result = parseProfileArtifact(Buffer.from("bounded profile text", "utf8"), "text");

    await expect(result).resolves.toMatchObject({ format: "text", text: "late success must be ignored" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
