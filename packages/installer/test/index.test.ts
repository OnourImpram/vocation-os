import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALL_EXECUTION_POLICY,
  InstallerError,
  installVerifiedBundle,
  parseChecksumManifest,
  uninstallVerifiedBundle,
  updateVerifiedBundle,
  verifyInstalledBundle,
  verifyBundle
} from "../src/index.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  await Promise.all(TEMP_ROOTS.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  source: string;
  target: string;
  manifest: unknown;
}> {
  const root = await mkdtemp(join(tmpdir(), "vocation-installer-"));
  TEMP_ROOTS.push(root);
  const source = join(root, "source");
  const target = join(root, "installed", "vocation-os");
  await mkdir(join(source, "vocation-os"), { recursive: true });
  const content = Buffer.from("---\nname: vocation-os\n---\n", "utf8");
  await writeFile(join(source, "vocation-os", "SKILL.md"), content);
  return {
    root,
    source,
    target,
    manifest: {
      schemaVersion: 1,
      algorithm: "sha256",
      files: [{
        path: "vocation-os/SKILL.md",
        sha256: createHash("sha256").update(content).digest("hex")
      }]
    }
  };
}

describe("checksum gated installer", () => {
  it("verifies every byte before a copy-only install", async () => {
    const input = await fixture();
    const receipt = await installVerifiedBundle({
      bundleRoot: input.source,
      targetDirectory: input.target,
      manifest: input.manifest
    });

    expect(receipt.policy).toBe(INSTALL_EXECUTION_POLICY);
    expect(await readFile(join(input.target, "vocation-os", "SKILL.md"), "utf8"))
      .toContain("name: vocation-os");
    await expect(verifyBundle({ bundleRoot: input.target, manifest: input.manifest }))
      .resolves.toMatchObject({ totalBytes: receipt.totalBytes });
  });

  it("fails closed on checksum mismatch before creating the target", async () => {
    const input = await fixture();
    await writeFile(join(input.source, "vocation-os", "SKILL.md"), "tampered");

    await expect(installVerifiedBundle({
      bundleRoot: input.source,
      targetDirectory: input.target,
      manifest: input.manifest
    })).rejects.toMatchObject<Partial<InstallerError>>({ code: "checksum-mismatch" });
  });

  it("rejects traversal and remote sources", async () => {
    expect(() => parseChecksumManifest({
      schemaVersion: 1,
      algorithm: "sha256",
      files: [{ path: "../SKILL.md", sha256: "a".repeat(64) }]
    })).toThrow("normalized relative POSIX path");

    await expect(verifyBundle({
      bundleRoot: "https://example.com/install.tar.gz",
      manifest: {
        schemaVersion: 1,
        algorithm: "sha256",
        files: [{ path: "SKILL.md", sha256: "a".repeat(64) }]
      }
    })).rejects.toMatchObject<Partial<InstallerError>>({ code: "remote-source" });
  });

  it("atomically updates a verified installation and records both manifests", async () => {
    const input = await fixture();
    await installVerifiedBundle({ bundleRoot: input.source, targetDirectory: input.target, manifest: input.manifest });
    const nextSource = join(input.root, "next");
    await mkdir(join(nextSource, "vocation-os"), { recursive: true });
    const nextContent = Buffer.from("---\nname: vocation-os\nversion: next\n---\n", "utf8");
    await writeFile(join(nextSource, "vocation-os", "SKILL.md"), nextContent);
    const nextManifest = {
      schemaVersion: 1,
      algorithm: "sha256",
      files: [{
        path: "vocation-os/SKILL.md",
        sha256: createHash("sha256").update(nextContent).digest("hex")
      }]
    };

    const receipt = await updateVerifiedBundle({
      bundleRoot: nextSource,
      targetDirectory: input.target,
      currentManifest: input.manifest,
      nextManifest
    });

    expect(receipt.previousManifestDigest).not.toBe(receipt.manifestDigest);
    expect(await readFile(join(input.target, "vocation-os", "SKILL.md"), "utf8")).toContain("version: next");
    await expect(verifyInstalledBundle({ targetDirectory: input.target, manifest: nextManifest })).resolves.toBeDefined();
  });

  it("leaves the current installation untouched when the next bundle fails verification", async () => {
    const input = await fixture();
    await installVerifiedBundle({ bundleRoot: input.source, targetDirectory: input.target, manifest: input.manifest });
    const invalidManifest = {
      schemaVersion: 1,
      algorithm: "sha256",
      files: [{ path: "vocation-os/SKILL.md", sha256: "0".repeat(64) }]
    };

    await expect(updateVerifiedBundle({
      bundleRoot: input.source,
      targetDirectory: input.target,
      currentManifest: input.manifest,
      nextManifest: invalidManifest
    })).rejects.toMatchObject<Partial<InstallerError>>({ code: "checksum-mismatch" });
    await expect(verifyInstalledBundle({ targetDirectory: input.target, manifest: input.manifest })).resolves.toBeDefined();
  });

  it("refuses to verify or uninstall modified and unowned installations", async () => {
    const input = await fixture();
    await installVerifiedBundle({ bundleRoot: input.source, targetDirectory: input.target, manifest: input.manifest });
    await writeFile(join(input.target, "unowned.txt"), "operator data");

    await expect(verifyInstalledBundle({ targetDirectory: input.target, manifest: input.manifest }))
      .rejects.toMatchObject<Partial<InstallerError>>({ code: "unowned-content" });
    await expect(uninstallVerifiedBundle({ targetDirectory: input.target, manifest: input.manifest }))
      .rejects.toMatchObject<Partial<InstallerError>>({ code: "unowned-content" });
    await expect(access(join(input.target, "unowned.txt"))).resolves.toBeUndefined();
  });

  it("refuses symbolic links in an installed bundle", async () => {
    const input = await fixture();
    await installVerifiedBundle({ bundleRoot: input.source, targetDirectory: input.target, manifest: input.manifest });
    const linkPath = join(input.target, "linked-skill.md");
    try {
      await symlink(join(input.target, "vocation-os", "SKILL.md"), linkPath, "file");
    } catch (error) {
      if (process.platform === "win32" && error && typeof error === "object" && "code" in error && error.code === "EPERM") return;
      throw error;
    }
    await expect(uninstallVerifiedBundle({ targetDirectory: input.target, manifest: input.manifest }))
      .rejects.toMatchObject<Partial<InstallerError>>({ code: "unsupported-file" });
  });

  it("uninstalls only an exact verified installation", async () => {
    const input = await fixture();
    await installVerifiedBundle({ bundleRoot: input.source, targetDirectory: input.target, manifest: input.manifest });
    const receipt = await uninstallVerifiedBundle({ targetDirectory: input.target, manifest: input.manifest });
    expect(receipt).toMatchObject({ removed: true, targetDirectory: input.target });
    await expect(access(input.target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
