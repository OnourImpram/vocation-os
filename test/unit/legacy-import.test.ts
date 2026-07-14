import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAutoApplyConfig } from "../../src/auto-apply.js";
import { encodeStateKey } from "../../src/state.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";
import { applyLegacyImport, planLegacyImport } from "../../src/storage/legacy-import.js";

const PASSPHRASE = "correct horse battery staple";

function ledgerEntry(sequence: number): Record<string, unknown> {
  return {
    actionId: `A-2026-00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    timestamp: `2026-07-11T10:00:0${sequence}.000Z`,
    mode: "auto",
    opportunityId: `OPP-LEGACY-${sequence}`,
    reversibilityTag: "R3",
    evidenceGatePassed: true,
    approvalRequired: true,
    approvalReceived: true,
    highStakesGatePassed: true,
    result: "draft_generated"
  };
}

function writeCompleteLegacyFixture(runtimeRoot: string): string[] {
  const stateDir = path.join(runtimeRoot, "_state");
  mkdirSync(stateDir, { recursive: true });
  const files = [
    path.join(stateDir, `${encodeStateKey("legacy:notes")}.json`),
    path.join(runtimeRoot, "auto-apply-config.json"),
    path.join(runtimeRoot, "action-ledger.jsonl")
  ];
  writeFileSync(files[0]!, `${JSON.stringify({ note: "synthetic legacy state" }, null, 2)}\n`, "utf8");
  writeFileSync(files[1]!, `${JSON.stringify(defaultAutoApplyConfig(), null, 2)}\n`, "utf8");
  writeFileSync(files[2]!, `${JSON.stringify(ledgerEntry(1))}\n`, "utf8");
  return files;
}

describe("legacy import", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = mkdtempSync(path.join(tmpdir(), "vocation-legacy-import-"));
  });

  afterEach(() => {
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("produces a deterministic, content-bound dry-run plan", () => {
    writeCompleteLegacyFixture(runtimeRoot);

    const first = planLegacyImport(runtimeRoot);
    const second = planLegacyImport(runtimeRoot);

    expect(first).toStrictEqual(second);
    expect(first.valid).toBe(true);
    expect(first.sourceCounts).toEqual({
      state: 1,
      "auto-apply-config": 1,
      "action-ledger": 1
    });
    expect(first.candidates).toHaveLength(3);
    expect(first.candidates.every((candidate) => candidate.eventId.startsWith("EVT-LEGACY-"))).toBe(true);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toMatch(
      /^State entry sha256:[a-f0-9]{64} has no inferred schema and will be imported as opaque validated JSON$/
    );
    expect(first.warnings.join(" ")).not.toContain("legacy:notes");
  });

  it("reports invalid JSON and malformed JSONL with source locations", () => {
    const stateDir = path.join(runtimeRoot, "_state");
    mkdirSync(stateDir, { recursive: true });
    const invalidStateName = `${encodeStateKey("legacy:broken")}.json`;
    writeFileSync(path.join(stateDir, invalidStateName), "{", "utf8");
    writeFileSync(
      path.join(runtimeRoot, "action-ledger.jsonl"),
      [
        JSON.stringify(ledgerEntry(1)),
        "not-json",
        JSON.stringify(ledgerEntry(2)),
        '{"actionId":'
      ].join("\n"),
      "utf8"
    );

    const plan = planLegacyImport(runtimeRoot);

    expect(plan.valid).toBe(false);
    expect(plan.errors.some((error) => /^State file sha256:[a-f0-9]{64}:/.test(error))).toBe(true);
    expect(plan.errors.join(" ")).not.toContain(invalidStateName);
    expect(plan.errors.some((error) => error.startsWith("Action ledger line 2:"))).toBe(true);
    expect(plan.errors.some((error) => error.startsWith("Action ledger line 4 (unterminated final line):"))).toBe(true);
    expect(plan.sourceCounts["action-ledger"]).toBe(2);
  });

  it("requires approval of the exact dry-run plan hash", async () => {
    writeCompleteLegacyFixture(runtimeRoot);
    const plan = planLegacyImport(runtimeRoot);
    const store = await EncryptedEventStore.open(path.join(runtimeRoot, "vocation.db"), PASSPHRASE);
    try {
      await expect(
        applyLegacyImport(store, plan, `sha256:${"f".repeat(64)}`)
      ).rejects.toThrow("Legacy import plan hash does not match approval");
      expect(await store.readAll()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("is idempotent and preserves every legacy source byte for byte", async () => {
    const sourceFiles = writeCompleteLegacyFixture(runtimeRoot);
    const originalContents = new Map(
      sourceFiles.map((filePath) => [filePath, readFileSync(filePath)])
    );
    const plan = planLegacyImport(runtimeRoot);
    const store = await EncryptedEventStore.open(path.join(runtimeRoot, "vocation.db"), PASSPHRASE);
    try {
      const first = await applyLegacyImport(
        store,
        plan,
        plan.planHash,
        new Date("2026-07-11T12:00:00.000Z")
      );
      const second = await applyLegacyImport(
        store,
        plan,
        plan.planHash,
        new Date("2026-07-11T13:00:00.000Z")
      );

      expect(first).toMatchObject({ imported: 3, alreadyImported: 0, sourceFilesPreserved: true });
      expect(second).toMatchObject({ imported: 0, alreadyImported: 3, sourceFilesPreserved: true });
      expect(second.eventIds).toEqual(first.eventIds);
      expect(await store.readAll()).toHaveLength(3);
    } finally {
      await store.close();
    }

    for (const filePath of sourceFiles) {
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(originalContents.get(filePath));
    }
  });

  it("rejects a plaintext receipt that has no authenticated import event", async () => {
    writeCompleteLegacyFixture(runtimeRoot);
    const plan = planLegacyImport(runtimeRoot);
    const candidate = plan.candidates[0];
    if (!candidate) throw new Error("Legacy import fixture did not create a candidate");
    const store = await EncryptedEventStore.open(path.join(runtimeRoot, "vocation.db"), PASSPHRASE);
    try {
      store.recordLegacyImportReceipt({
        sourceDigest: candidate.sourceDigest,
        sourceKind: candidate.sourceKind,
        sourceLocatorHash: candidate.sourceLocatorHash,
        eventId: candidate.eventId,
        importedAt: "2026-07-11T11:00:00.000Z"
      });
      await expect(applyLegacyImport(store, plan, plan.planHash))
        .rejects.toThrow("not bound to an authenticated event");
      expect(await store.readAll()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});
