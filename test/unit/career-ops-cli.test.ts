import { describe, expect, it } from "vitest";
import { runCareerOpsCli } from "../../src/career-ops-cli.js";

describe("career operations CLI", () => {
  it("lists only the shipped synthetic adapter", async () => {
    const output: string[] = [];
    const exitCode = await runCareerOpsCli(["adapters"], (value) => output.push(value));
    const parsed = JSON.parse(output.join("")) as { adapters: Array<{ adapterId: string; maturity: string }> };

    expect(exitCode).toBe(0);
    expect(parsed.adapters).toHaveLength(1);
    expect(parsed.adapters[0]).toMatchObject({
      adapterId: "career-ops-local-fixture",
      maturity: "synthetic"
    });
  });

  it("runs the full synthetic verified execution demo", async () => {
    const output: string[] = [];
    const exitCode = await runCareerOpsCli(
      ["demo", "--at", "2026-08-28T09:00:00.000Z"],
      (value) => output.push(value)
    );
    const parsed = JSON.parse(output.join("")) as {
      verification: { status: string };
      outbox: { status: string };
      applicationAttempt: { status: string };
    };

    expect(exitCode).toBe(0);
    expect(parsed.verification.status).toBe("verified");
    expect(parsed.outbox.status).toBe("confirmed");
    expect(parsed.applicationAttempt.status).toBe("confirmed");
  });

  it("fails closed on an unknown command", async () => {
    const output: string[] = [];
    const exitCode = await runCareerOpsCli(["send-real-applications"], (value) => output.push(value));

    expect(exitCode).toBe(2);
    expect(output.join("")).toContain("Unknown career operations command");
  });
});
