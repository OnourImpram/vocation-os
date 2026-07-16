import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32
} from "node:path";

export const INSTALL_EXECUTION_POLICY = "copy-only" as const;
export const MAX_INSTALL_FILES = 4_096;
export const MAX_INSTALL_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_INSTALL_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface ChecksumEntry {
  path: string;
  sha256: string;
}

export interface ChecksumManifest {
  schemaVersion: 1;
  algorithm: "sha256";
  files: readonly ChecksumEntry[];
}

export interface VerifiedFile {
  path: string;
  sha256: string;
  size: number;
}

export interface VerificationReceipt {
  algorithm: "sha256";
  manifestDigest: string;
  files: readonly VerifiedFile[];
  totalBytes: number;
}

export interface InstallReceipt extends VerificationReceipt {
  policy: typeof INSTALL_EXECUTION_POLICY;
  targetDirectory: string;
}

export interface UpdateReceipt extends InstallReceipt {
  previousManifestDigest: string;
}

export interface UninstallReceipt extends VerificationReceipt {
  policy: typeof INSTALL_EXECUTION_POLICY;
  targetDirectory: string;
  removed: true;
}

export type InstallerErrorCode =
  | "invalid-manifest"
  | "unsafe-path"
  | "remote-source"
  | "missing-file"
  | "unsupported-file"
  | "checksum-mismatch"
  | "bundle-too-large"
  | "target-exists"
  | "target-modified"
  | "unowned-content"
  | "update-failed"
  | "cleanup-failed"
  | "rollback-failed";

export class InstallerError extends Error {
  public constructor(public readonly code: InstallerErrorCode, message: string) {
    super(message);
    this.name = "InstallerError";
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstallerError("invalid-manifest", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function manifestPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InstallerError("invalid-manifest", `${field} must be a non-empty string`);
  }
  if (
    value.includes("\\")
    || value.includes("\0")
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new InstallerError("unsafe-path", `${field} must be a normalized relative POSIX path`);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new InstallerError("invalid-manifest", `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function parseChecksumManifest(value: unknown): ChecksumManifest {
  const manifest = objectValue(value, "Checksum manifest");
  if (manifest.schemaVersion !== 1 || manifest.algorithm !== "sha256") {
    throw new InstallerError("invalid-manifest", "Checksum manifest must use schema version 1 and SHA-256");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new InstallerError("invalid-manifest", "Checksum manifest must contain at least one file");
  }
  if (manifest.files.length > MAX_INSTALL_FILES) {
    throw new InstallerError("bundle-too-large", "Checksum manifest contains too many files");
  }
  const files = manifest.files.map((valueAtIndex, index): ChecksumEntry => {
    const entry = objectValue(valueAtIndex, `files[${index}]`);
    return Object.freeze({
      path: manifestPath(entry.path, `files[${index}].path`),
      sha256: sha256(entry.sha256, `files[${index}].sha256`)
    });
  });
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new InstallerError("invalid-manifest", "Checksum manifest file paths must be unique");
  }
  return Object.freeze({ schemaVersion: 1, algorithm: "sha256", files: Object.freeze(files) });
}

function assertLocalPath(value: string, field: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    throw new InstallerError("remote-source", `${field} must be a local filesystem path`);
  }
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new InstallerError("unsafe-path", `${field} is invalid`);
  }
  return resolve(value);
}

function resolveContained(root: string, entryPath: string): string {
  const target = resolve(root, ...entryPath.split("/"));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new InstallerError("unsafe-path", `Manifest path escapes the bundle root: ${entryPath}`);
  }
  return target;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestManifest(manifest: ChecksumManifest): string {
  const canonical = [...manifest.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\0${entry.sha256}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function removeTree(value: string, force: boolean): Promise<void> {
  await rm(value, {
    recursive: true,
    force,
    maxRetries: 5,
    retryDelay: 200
  });
}

function safeTargetDirectory(value: string): string {
  const target = assertLocalPath(value, "Target directory");
  if (target === parse(target).root) {
    throw new InstallerError("unsafe-path", "Target directory cannot be a filesystem root");
  }
  return target;
}

function expectedDirectories(manifest: ChecksumManifest): Set<string> {
  const directories = new Set<string>();
  for (const entry of manifest.files) {
    const segments = entry.path.split("/");
    segments.pop();
    while (segments.length > 0) {
      directories.add(segments.join("/"));
      segments.pop();
    }
  }
  return directories;
}

async function installedTree(root: string): Promise<{ files: Set<string>; directories: Set<string> }> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    if (isMissing(error)) throw new InstallerError("missing-file", "Installed bundle does not exist");
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new InstallerError("unsupported-file", "Installed bundle root must be a regular directory");
  }

  const files = new Set<string>();
  const directories = new Set<string>();
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  let entryCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_INSTALL_FILES * 2) {
        throw new InstallerError("bundle-too-large", "Installed bundle contains too many entries");
      }
      const relativePath = current.relative.length === 0
        ? entry.name
        : `${current.relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new InstallerError("unsupported-file", `Installed bundle contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        directories.add(relativePath);
        pending.push({ absolute: resolve(current.absolute, entry.name), relative: relativePath });
        continue;
      }
      if (!entry.isFile()) {
        throw new InstallerError("unsupported-file", `Installed bundle contains an unsupported entry: ${relativePath}`);
      }
      files.add(relativePath);
    }
  }
  return { files, directories };
}

async function readVerifiedFile(
  root: string,
  rootRealPath: string,
  entry: ChecksumEntry
): Promise<{ receipt: VerifiedFile; bytes: Buffer }> {
  const source = resolveContained(root, entry.path);
  let handle;
  try {
    handle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isMissing(error)) throw new InstallerError("missing-file", `Bundle file is missing: ${entry.path}`);
    if (hasErrorCode(error, "ELOOP")) {
      throw new InstallerError("unsupported-file", `Bundle entry must not be a symbolic link: ${entry.path}`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new InstallerError("unsupported-file", `Bundle entry must be a regular file: ${entry.path}`);
    }
    if (metadata.size > MAX_INSTALL_FILE_BYTES) {
      throw new InstallerError("bundle-too-large", `Bundle file exceeds the size limit: ${entry.path}`);
    }
    const pathMetadata = await lstat(source);
    if (
      !pathMetadata.isFile()
      || pathMetadata.isSymbolicLink()
      || pathMetadata.dev !== metadata.dev
      || pathMetadata.ino !== metadata.ino
    ) {
      throw new InstallerError("unsupported-file", `Bundle entry changed during verification: ${entry.path}`);
    }
    const sourceRealPath = await realpath(source);
    const fromRoot = relative(rootRealPath, sourceRealPath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new InstallerError("unsafe-path", `Bundle file resolves outside the source root: ${entry.path}`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_INSTALL_FILE_BYTES) {
      throw new InstallerError("bundle-too-large", `Bundle file exceeds the size limit: ${entry.path}`);
    }
    const actual = digestBytes(bytes);
    if (actual !== entry.sha256) {
      throw new InstallerError("checksum-mismatch", `Checksum mismatch for bundle file: ${entry.path}`);
    }
    return {
      receipt: Object.freeze({ path: entry.path, sha256: actual, size: bytes.byteLength }),
      bytes
    };
  } finally {
    await handle.close();
  }
}

async function collectVerifiedFiles(
  bundleRoot: string,
  manifest: ChecksumManifest
): Promise<{ files: readonly { receipt: VerifiedFile; bytes: Buffer }[]; totalBytes: number }> {
  const root = assertLocalPath(bundleRoot, "Bundle root");
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(root);
  } catch (error) {
    if (isMissing(error)) throw new InstallerError("missing-file", "Bundle root does not exist");
    throw error;
  }
  const files: Array<{ receipt: VerifiedFile; bytes: Buffer }> = [];
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const file = await readVerifiedFile(root, rootRealPath, entry);
    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_INSTALL_BUNDLE_BYTES) {
      throw new InstallerError("bundle-too-large", "Bundle exceeds the total size limit");
    }
    files.push(file);
  }
  return { files: Object.freeze(files), totalBytes };
}

export async function verifyBundle(input: {
  bundleRoot: string;
  manifest: ChecksumManifest | unknown;
}): Promise<VerificationReceipt> {
  const manifest = parseChecksumManifest(input.manifest);
  const verified = await collectVerifiedFiles(input.bundleRoot, manifest);
  return Object.freeze({
    algorithm: "sha256",
    manifestDigest: digestManifest(manifest),
    files: Object.freeze(verified.files.map((file) => file.receipt)),
    totalBytes: verified.totalBytes
  });
}

export async function verifyInstalledBundle(input: {
  targetDirectory: string;
  manifest: ChecksumManifest | unknown;
}): Promise<VerificationReceipt> {
  const target = safeTargetDirectory(input.targetDirectory);
  const manifest = parseChecksumManifest(input.manifest);
  const tree = await installedTree(target);
  const expectedFiles = new Set(manifest.files.map((entry) => entry.path));
  const expectedDirs = expectedDirectories(manifest);
  const unexpectedFile = [...tree.files].find((entry) => !expectedFiles.has(entry));
  const unexpectedDirectory = [...tree.directories].find((entry) => !expectedDirs.has(entry));
  if (unexpectedFile || unexpectedDirectory) {
    throw new InstallerError(
      "unowned-content",
      `Installed bundle contains unowned content: ${unexpectedFile ?? unexpectedDirectory}`
    );
  }
  if (tree.files.size !== expectedFiles.size || tree.directories.size !== expectedDirs.size) {
    throw new InstallerError("target-modified", "Installed bundle structure does not match its manifest");
  }
  return verifyBundle({ bundleRoot: target, manifest });
}

async function writeVerifiedFiles(
  directory: string,
  files: readonly { receipt: VerifiedFile; bytes: Buffer }[]
): Promise<void> {
  for (const file of files) {
    const destination = resolveContained(directory, file.receipt.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
  }
}

export async function installVerifiedBundle(input: {
  bundleRoot: string;
  targetDirectory: string;
  manifest: ChecksumManifest | unknown;
}): Promise<InstallReceipt> {
  const manifest = parseChecksumManifest(input.manifest);
  const verified = await collectVerifiedFiles(input.bundleRoot, manifest);
  const target = safeTargetDirectory(input.targetDirectory);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await pathExists(target)) throw new InstallerError("target-exists", "Target directory already exists");

  const stage = resolve(parent, `.${basename(target)}.staging-${randomUUID()}`);
  let stageCreated = false;
  let targetActivated = false;
  try {
    await mkdir(stage, { recursive: false, mode: 0o700 });
    stageCreated = true;
    await writeVerifiedFiles(stage, verified.files);
    await verifyInstalledBundle({ targetDirectory: stage, manifest });
    await rename(stage, target);
    stageCreated = false;
    targetActivated = true;
    await verifyInstalledBundle({ targetDirectory: target, manifest });
  } catch (error) {
    if (stageCreated) await removeTree(stage, true);
    if (targetActivated && await pathExists(target)) await removeTree(target, false);
    throw error;
  }

  return Object.freeze({
    policy: INSTALL_EXECUTION_POLICY,
    targetDirectory: target,
    algorithm: "sha256",
    manifestDigest: digestManifest(manifest),
    files: Object.freeze(verified.files.map((file) => file.receipt)),
    totalBytes: verified.totalBytes
  });
}

export async function updateVerifiedBundle(input: {
  bundleRoot: string;
  targetDirectory: string;
  currentManifest: ChecksumManifest | unknown;
  nextManifest: ChecksumManifest | unknown;
}): Promise<UpdateReceipt> {
  const target = safeTargetDirectory(input.targetDirectory);
  const currentManifest = parseChecksumManifest(input.currentManifest);
  const nextManifest = parseChecksumManifest(input.nextManifest);
  const current = await verifyInstalledBundle({ targetDirectory: target, manifest: currentManifest });
  const next = await collectVerifiedFiles(input.bundleRoot, nextManifest);
  const parent = dirname(target);
  const stage = resolve(parent, `.${basename(target)}.staging-${randomUUID()}`);
  const backup = resolve(parent, `.${basename(target)}.backup-${randomUUID()}`);
  let stageCreated = false;
  let targetDetached = false;
  let nextActivated = false;

  try {
    await mkdir(stage, { recursive: false, mode: 0o700 });
    stageCreated = true;
    await writeVerifiedFiles(stage, next.files);
    await verifyInstalledBundle({ targetDirectory: stage, manifest: nextManifest });
    await rename(target, backup);
    targetDetached = true;
    await rename(stage, target);
    stageCreated = false;
    nextActivated = true;
    await verifyInstalledBundle({ targetDirectory: target, manifest: nextManifest });
  } catch (error) {
    try {
      if (nextActivated && await pathExists(target)) {
        await removeTree(target, false);
        nextActivated = false;
      }
      if (targetDetached && await pathExists(backup) && !await pathExists(target)) {
        await rename(backup, target);
        targetDetached = false;
      }
      await verifyInstalledBundle({ targetDirectory: target, manifest: currentManifest });
    } catch (rollbackError) {
      throw new InstallerError(
        "rollback-failed",
        `Atomic update failed and the previous installation could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      );
    } finally {
      if (stageCreated) await removeTree(stage, true);
    }
    throw new InstallerError(
      "update-failed",
      `Atomic update failed and the previous installation was restored: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await removeTree(backup, false);
    targetDetached = false;
  } catch (error) {
    throw new InstallerError(
      "cleanup-failed",
      `Update committed and verified, but the private backup could not be removed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return Object.freeze({
    policy: INSTALL_EXECUTION_POLICY,
    targetDirectory: target,
    previousManifestDigest: current.manifestDigest,
    algorithm: "sha256",
    manifestDigest: digestManifest(nextManifest),
    files: Object.freeze(next.files.map((file) => file.receipt)),
    totalBytes: next.totalBytes
  });
}

export async function uninstallVerifiedBundle(input: {
  targetDirectory: string;
  manifest: ChecksumManifest | unknown;
}): Promise<UninstallReceipt> {
  const target = safeTargetDirectory(input.targetDirectory);
  const manifest = parseChecksumManifest(input.manifest);
  const verified = await verifyInstalledBundle({ targetDirectory: target, manifest });
  const quarantine = resolve(dirname(target), `.${basename(target)}.uninstall-${randomUUID()}`);
  await rename(target, quarantine);
  try {
    await verifyInstalledBundle({ targetDirectory: quarantine, manifest });
  } catch (error) {
    await rename(quarantine, target);
    throw error;
  }
  try {
    await removeTree(quarantine, false);
  } catch (error) {
    try {
      await verifyInstalledBundle({ targetDirectory: quarantine, manifest });
      await rename(quarantine, target);
    } catch (rollbackError) {
      throw new InstallerError(
        "rollback-failed",
        `Uninstall failed and the verified installation could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      );
    }
    throw new InstallerError(
      "update-failed",
      `Uninstall failed and the verified installation was restored: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return Object.freeze({
    ...verified,
    policy: INSTALL_EXECUTION_POLICY,
    targetDirectory: target,
    removed: true
  });
}
