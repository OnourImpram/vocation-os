import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../src/hash.js";
import {
  ArtifactVault,
  assertArtifactManifest,
  validateArtifactManifest,
  type ArtifactManifest
} from "../../src/storage/artifact-vault.js";

const filesystemProbe = vi.hoisted(() => ({
  failRename: false,
  fsyncCalls: 0,
  renameCalls: 0
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (descriptor: Parameters<typeof actual.fsyncSync>[0]): void => {
      filesystemProbe.fsyncCalls += 1;
      actual.fsyncSync(descriptor);
    },
    renameSync: (
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1]
    ): void => {
      filesystemProbe.renameCalls += 1;
      if (filesystemProbe.failRename && String(oldPath).endsWith(".tmp")) {
        throw new Error("simulated artifact rename failure");
      }
      actual.renameSync(oldPath, newPath);
    }
  };
});

const MASTER_KEY = Buffer.alloc(32, 0x41);
const WRONG_KEY = Buffer.alloc(32, 0x52);

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...filesUnder(entryPath));
    else files.push(entryPath);
  }
  return files;
}

describe("content-addressed encrypted artifact vault", () => {
  let dir: string;
  let vaultRoot: string;
  let vault: ArtifactVault;

  beforeEach(() => {
    filesystemProbe.failRename = false;
    filesystemProbe.fsyncCalls = 0;
    filesystemProbe.renameCalls = 0;
    dir = mkdtempSync(path.join(tmpdir(), "vocation-artifact-vault-"));
    vaultRoot = path.join(dir, "vault");
    vault = new ArtifactVault({ rootPath: vaultRoot, masterKey: MASTER_KEY });
  });

  afterEach(() => {
    filesystemProbe.failRename = false;
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round trips a file through an authenticated envelope without recording its source path", () => {
    const sourcePath = path.join(dir, "private-source-cv-name.pdf");
    const content = Buffer.from("private CV payload that must remain encrypted", "utf8");
    writeFileSync(sourcePath, content);

    const result = vault.storeFile(sourcePath);

    expect(result.deduplicated).toBe(false);
    expect(result.manifest).toEqual({
      format: "vocation-os-artifact",
      version: 1,
      cipher: "aes-256-gcm",
      contentHash: sha256(content),
      storageLocator: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      sizeBytes: content.byteLength
    });
    expect(validateArtifactManifest(result.manifest)).toEqual({ valid: true, errors: [] });
    expect(JSON.stringify(result.manifest)).not.toContain(sourcePath);
    expect(JSON.stringify(result.manifest)).not.toContain(path.basename(sourcePath));
    expect(vault.read(result.manifest)).toEqual(content);

    const rawEnvelope = readFileSync(vault.artifactPath(result.manifest), "utf8");
    expect(rawEnvelope).not.toContain(content.toString("utf8"));
    expect(rawEnvelope).not.toContain(sourcePath);
    expect(rawEnvelope).not.toContain(result.manifest.contentHash);
    expect(Object.keys(JSON.parse(rawEnvelope) as Record<string, unknown>).sort()).toEqual([
      "cipher",
      "ciphertext",
      "format",
      "nonce",
      "tag",
      "version"
    ]);
    expect(filesystemProbe.fsyncCalls).toBeGreaterThan(0);
    expect(filesystemProbe.renameCalls).toBe(1);
  });

  it("deduplicates identical plaintext idempotently under one keyed locator", () => {
    const content = Buffer.from("one content-addressed artifact", "utf8");

    const first = vault.store(content);
    const second = vault.store(content);

    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ manifest: first.manifest, deduplicated: true });
    expect(filesUnder(vaultRoot).filter((file) => file.endsWith(".vocationart"))).toHaveLength(1);
    expect(filesUnder(vaultRoot).filter((file) => file.endsWith(".tmp"))).toHaveLength(0);
  });

  it("detects ciphertext tampering and refuses to replace a corrupt dedupe target", () => {
    const content = Buffer.from("tamper-sensitive artifact", "utf8");
    const { manifest } = vault.store(content);
    const artifactPath = vault.artifactPath(manifest);
    const envelope = JSON.parse(readFileSync(artifactPath, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    envelope.ciphertext = ciphertext.toString("base64url");
    writeFileSync(artifactPath, `${JSON.stringify(envelope)}\n`, "utf8");

    expect(() => vault.read(manifest)).toThrow("cannot be authenticated");
    expect(() => vault.store(content)).toThrow("cannot be authenticated");
  });

  it("fails closed when a manifest is presented with the wrong vault key", () => {
    const { manifest } = vault.store(Buffer.from("wrong-key probe", "utf8"));
    const wrongVault = new ArtifactVault({ rootPath: vaultRoot, masterKey: WRONG_KEY });
    try {
      expect(() => wrongVault.read(manifest)).toThrow("cannot be authenticated");
    } finally {
      wrongVault.close();
    }
  });

  it("rejects record traversal and storage-directory symlink escapes", () => {
    const { manifest } = vault.store(Buffer.from("containment probe", "utf8"));
    const forged = {
      ...manifest,
      storageLocator: "hmac-sha256:../../vault-escape",
      sourcePath: path.join(dir, "private-source.pdf")
    };
    expect(validateArtifactManifest(forged)).toMatchObject({ valid: false });
    expect(() => assertArtifactManifest(forged)).toThrow("unexpected property: sourcePath");
    expect(() => vault.read(forged)).toThrow("Artifact manifest validation failed");

    const artifactPath = vault.artifactPath(manifest);
    const shardPath = path.dirname(artifactPath);
    const outsideShard = path.join(dir, "vault-escape");
    mkdirSync(outsideShard);
    copyFileSync(artifactPath, path.join(outsideShard, path.basename(artifactPath)));
    rmSync(shardPath, { recursive: true, force: true });
    symlinkSync(outsideShard, shardPath, process.platform === "win32" ? "junction" : "dir");

    expect(() => vault.read(manifest)).toThrow("must not be symbolic links");
  });

  it("enforces the configured maximum before an oversized artifact is persisted", () => {
    const limitedRoot = path.join(dir, "limited-vault");
    const limitedVault = new ArtifactVault({
      rootPath: limitedRoot,
      masterKey: MASTER_KEY,
      maxArtifactBytes: 4
    });
    try {
      expect(() => limitedVault.store(Buffer.alloc(5, 0x61))).toThrow(
        "exceeds configured maximum of 4 bytes"
      );
      expect(filesUnder(limitedRoot).filter((file) => file.endsWith(".vocationart"))).toHaveLength(0);
    } finally {
      limitedVault.close();
    }
  });

  it("removes only its exact temporary file when atomic rename fails", () => {
    const content = Buffer.from("temporary cleanup probe", "utf8");
    filesystemProbe.failRename = true;

    expect(() => vault.store(content)).toThrow("simulated artifact rename failure");
    expect(filesUnder(vaultRoot).filter((file) => file.endsWith(".tmp"))).toHaveLength(0);
    expect(filesUnder(vaultRoot).filter((file) => file.endsWith(".vocationart"))).toHaveLength(0);

    filesystemProbe.failRename = false;
    const stored = vault.store(content);
    expect(vault.read(stored.manifest)).toEqual(content);
  });

  it("validates manifests without accepting raw paths or unbounded record fields", () => {
    const { manifest } = vault.store(Buffer.from("manifest validation probe", "utf8"));
    const recordWithPath = {
      ...manifest,
      sourcePath: "C:\\private\\resume.pdf"
    } satisfies ArtifactManifest & { sourcePath: string };

    expect(validateArtifactManifest(recordWithPath)).toEqual({
      valid: false,
      errors: ["unexpected property: sourcePath"]
    });
  });
});
