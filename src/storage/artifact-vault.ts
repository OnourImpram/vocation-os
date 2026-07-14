import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { sha256, stableStringify } from "../hash.js";

const ARTIFACT_FORMAT = "vocation-os-artifact" as const;
const ENVELOPE_FORMAT = "vocation-os-encrypted-artifact" as const;
const CIPHER = "aes-256-gcm" as const;
const LOCATOR_PREFIX = "hmac-sha256:";
const OBJECT_DIRECTORY = "objects";
const ARTIFACT_EXTENSION = ".vocationart";
const ENVELOPE_OVERHEAD_LIMIT = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KDF_SALT = Buffer.from("vocation-os:artifact-vault:v1", "utf8");
const ENCRYPTION_INFO = Buffer.from("aes-256-gcm-content-key", "utf8");
const LOCATOR_INFO = Buffer.from("hmac-sha256-locator-key", "utf8");
const LOCATOR_DOMAIN = Buffer.from("vocation-os:artifact-locator:v1\0", "utf8");
const AAD_DOMAIN = "vocation-os:artifact-envelope:v1";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LOCATOR_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface ArtifactManifest {
  format: typeof ARTIFACT_FORMAT;
  version: 1;
  cipher: typeof CIPHER;
  contentHash: string;
  storageLocator: string;
  sizeBytes: number;
}

export interface ArtifactManifestValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ArtifactVaultOptions {
  rootPath: string;
  masterKey: Uint8Array;
  maxArtifactBytes?: number;
}

export interface StoreArtifactResult {
  manifest: ArtifactManifest;
  deduplicated: boolean;
}

interface ArtifactEnvelope {
  format: typeof ENVELOPE_FORMAT;
  version: 1;
  cipher: typeof CIPHER;
  nonce: string;
  tag: string;
  ciphertext: string;
}

class AtomicArtifactWriteError extends Error {
  public constructor(
    message: string,
    cause: unknown,
    public readonly committed: boolean
  ) {
    super(message, { cause });
    this.name = "AtomicArtifactWriteError";
  }
}

const MANIFEST_KEYS = new Set<keyof ArtifactManifest>([
  "format",
  "version",
  "cipher",
  "contentHash",
  "storageLocator",
  "sizeBytes"
]);

const ENVELOPE_KEYS = new Set<keyof ArtifactEnvelope>([
  "format",
  "version",
  "cipher",
  "nonce",
  "tag",
  "ciphertext"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function validateArtifactManifest(value: unknown): ArtifactManifestValidationResult {
  if (!isRecord(value)) {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  const errors: string[] = [];
  for (const key of MANIFEST_KEYS) {
    if (!hasOwn(value, key)) errors.push(`missing property: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key as keyof ArtifactManifest)) errors.push(`unexpected property: ${key}`);
  }
  if (hasOwn(value, "format") && value["format"] !== ARTIFACT_FORMAT) {
    errors.push(`format must be ${ARTIFACT_FORMAT}`);
  }
  if (hasOwn(value, "version") && value["version"] !== 1) {
    errors.push("version must be 1");
  }
  if (hasOwn(value, "cipher") && value["cipher"] !== CIPHER) {
    errors.push(`cipher must be ${CIPHER}`);
  }
  if (hasOwn(value, "contentHash") && (
    typeof value["contentHash"] !== "string" || !SHA256_PATTERN.test(value["contentHash"])
  )) {
    errors.push("contentHash must be a canonical SHA-256 value");
  }
  if (hasOwn(value, "storageLocator") && (
    typeof value["storageLocator"] !== "string" || !LOCATOR_PATTERN.test(value["storageLocator"])
  )) {
    errors.push("storageLocator must be a canonical keyed SHA-256 locator");
  }
  if (hasOwn(value, "sizeBytes") && (
    typeof value["sizeBytes"] !== "number"
    || !Number.isSafeInteger(value["sizeBytes"])
    || value["sizeBytes"] < 0
  )) {
    errors.push("sizeBytes must be a non-negative safe integer");
  }
  return { valid: errors.length === 0, errors };
}

export function assertArtifactManifest(value: unknown): asserts value is ArtifactManifest {
  const result = validateArtifactManifest(value);
  if (!result.valid) {
    throw new Error(`Artifact manifest validation failed: ${result.errors.join("; ")}`);
  }
}

export function parseArtifactManifest(value: unknown): ArtifactManifest {
  assertArtifactManifest(value);
  return value;
}

export function generateArtifactVaultKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

function validateMasterKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== KEY_LENGTH) {
    throw new Error("Artifact vault master key must contain exactly 32 bytes");
  }
  const key = Buffer.from(value);
  let nonZero = 0;
  for (const byte of key) nonZero |= byte;
  if (nonZero === 0) {
    key.fill(0);
    throw new Error("Artifact vault master key must not be all zeroes");
  }
  return key;
}

function deriveSubkey(masterKey: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, KDF_SALT, info, KEY_LENGTH));
}

function validateMaximumSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Artifact maximum size must be a positive safe integer");
  }
  const encodedLimit = 4 * Math.ceil(value / 3) + ENVELOPE_OVERHEAD_LIMIT;
  if (!Number.isSafeInteger(encodedLimit)) {
    throw new Error("Artifact maximum size is too large for a bounded envelope");
  }
  return value;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
  );
}

function assertWithinRoot(root: string, candidate: string): void {
  if (!isWithinRoot(root, candidate)) {
    throw new Error("Artifact storage path escapes the configured vault root");
  }
}

function assertPlainDirectory(directoryPath: string, rootPath: string): string {
  const metadata = lstatSync(directoryPath);
  if (metadata.isSymbolicLink()) {
    throw new Error("Artifact vault storage directories must not be symbolic links");
  }
  if (!metadata.isDirectory()) {
    throw new Error("Artifact vault storage path is not a directory");
  }
  const canonicalPath = realpathSync(directoryPath);
  assertWithinRoot(rootPath, canonicalPath);
  return canonicalPath;
}

function canonicalBase64Url(value: unknown, label: string, expectedLength?: number): Buffer {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`Artifact envelope ${label} is not canonical base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(`Artifact envelope ${label} is not canonical base64url`);
  }
  if (expectedLength !== undefined && decoded.byteLength !== expectedLength) {
    throw new Error(`Artifact envelope ${label} has an invalid length`);
  }
  return decoded;
}

function parseEnvelope(raw: Buffer): ArtifactEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Artifact envelope is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("Artifact envelope must be an object");
  for (const key of ENVELOPE_KEYS) {
    if (!hasOwn(value, key)) throw new Error(`Artifact envelope is missing property: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.has(key as keyof ArtifactEnvelope)) {
      throw new Error(`Artifact envelope contains unexpected property: ${key}`);
    }
  }
  if (value["format"] !== ENVELOPE_FORMAT || value["version"] !== 1 || value["cipher"] !== CIPHER) {
    throw new Error("Unsupported VocationOS artifact envelope");
  }
  canonicalBase64Url(value["nonce"], "nonce", NONCE_LENGTH).fill(0);
  canonicalBase64Url(value["tag"], "tag", TAG_LENGTH).fill(0);
  canonicalBase64Url(value["ciphertext"], "ciphertext").fill(0);
  return value as unknown as ArtifactEnvelope;
}

function envelopeAad(manifest: ArtifactManifest): Buffer {
  return Buffer.from(`${AAD_DOMAIN}\0${stableStringify(manifest)}`, "utf8");
}

function fsyncDirectory(directoryPath: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directoryPath, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : null;
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function removeExactTemporaryFile(temporaryPath: string): void {
  if (!existsSync(temporaryPath)) return;
  rmSync(temporaryPath, { force: true });
}

function readBounded(
  descriptor: number,
  maximumBytes: number,
  oversizedMessage: string
): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const requestedBytes = Math.min(READ_CHUNK_BYTES, maximumBytes - totalBytes + 1);
      const chunk = Buffer.allocUnsafe(requestedBytes);
      const bytesRead = readSync(descriptor, chunk, 0, requestedBytes, null);
      if (bytesRead === 0) {
        chunk.fill(0);
        const value = Buffer.concat(chunks, totalBytes);
        for (const storedChunk of chunks) storedChunk.fill(0);
        return value;
      }
      if (totalBytes + bytesRead > maximumBytes) {
        chunk.fill(0);
        throw new Error(oversizedMessage);
      }
      const storedChunk = chunk.subarray(0, bytesRead);
      chunks.push(storedChunk);
      totalBytes += bytesRead;
    }
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  }
}

export class ArtifactVault {
  private readonly vaultRoot: string;
  private readonly objectRoot: string;
  private readonly encryptionKey: Buffer;
  private readonly locatorKey: Buffer;
  private readonly maxArtifactBytes: number;
  private readonly maxEnvelopeBytes: number;
  private closed = false;

  public constructor(options: ArtifactVaultOptions) {
    if (typeof options.rootPath !== "string" || options.rootPath.trim().length === 0) {
      throw new Error("Artifact vault root path is required");
    }
    this.maxArtifactBytes = validateMaximumSize(
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
    );
    this.maxEnvelopeBytes = 4 * Math.ceil(this.maxArtifactBytes / 3) + ENVELOPE_OVERHEAD_LIMIT;

    const masterKey = validateMasterKey(options.masterKey);
    try {
      this.encryptionKey = deriveSubkey(masterKey, ENCRYPTION_INFO);
      this.locatorKey = deriveSubkey(masterKey, LOCATOR_INFO);
    } finally {
      masterKey.fill(0);
    }

    try {
      const requestedRoot = path.resolve(options.rootPath);
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      if (!statSync(requestedRoot).isDirectory()) {
        throw new Error("Artifact vault root path is not a directory");
      }
      this.vaultRoot = realpathSync(requestedRoot);
      this.objectRoot = path.join(this.vaultRoot, OBJECT_DIRECTORY);
      assertWithinRoot(this.vaultRoot, this.objectRoot);
      const objectRootExisted = existsSync(this.objectRoot);
      mkdirSync(this.objectRoot, { recursive: true, mode: 0o700 });
      const canonicalObjectRoot = assertPlainDirectory(this.objectRoot, this.vaultRoot);
      if (canonicalObjectRoot !== this.objectRoot) {
        throw new Error("Artifact vault object directory must be a direct child of the vault root");
      }
      if (!objectRootExisted) fsyncDirectory(this.vaultRoot);
    } catch (error) {
      this.encryptionKey.fill(0);
      this.locatorKey.fill(0);
      throw error;
    }
  }

  public root(): string {
    return this.vaultRoot;
  }

  public storeFile(sourcePath: string): StoreArtifactResult {
    this.assertOpen();
    if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
      throw new Error("Artifact source path is required");
    }
    const resolvedSource = path.resolve(sourcePath);
    const descriptor = openSync(resolvedSource, fsConstants.O_RDONLY);
    let content: Buffer | null = null;
    try {
      const sourceMetadata = fstatSync(descriptor);
      if (!sourceMetadata.isFile()) throw new Error("Artifact source must be a regular file");
      this.assertSize(sourceMetadata.size);
      content = readBounded(
        descriptor,
        this.maxArtifactBytes,
        `Artifact size exceeds configured maximum of ${this.maxArtifactBytes} bytes`
      );
      return this.store(content);
    } finally {
      content?.fill(0);
      closeSync(descriptor);
    }
  }

  public store(content: Uint8Array): StoreArtifactResult {
    this.assertOpen();
    if (!(content instanceof Uint8Array)) {
      throw new Error("Artifact content must be a Uint8Array");
    }
    const plaintext = Buffer.from(content);
    try {
      this.assertSize(plaintext.byteLength);
      const manifest = this.createManifest(plaintext);
      const artifactPath = this.pathForValidatedManifest(manifest);
      if (existsSync(artifactPath)) {
        this.verifyExistingArtifact(artifactPath, manifest);
        return { manifest, deduplicated: true };
      }

      const envelope = this.encrypt(plaintext, manifest);
      const encoded = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
      if (encoded.byteLength > this.maxEnvelopeBytes) {
        throw new Error("Encrypted artifact exceeds the configured maximum envelope size");
      }
      try {
        this.atomicWrite(artifactPath, encoded);
      } catch (error) {
        if (
          !(error instanceof AtomicArtifactWriteError)
          || error.committed
          || !existsSync(artifactPath)
        ) {
          throw error;
        }
        this.verifyExistingArtifact(artifactPath, manifest);
        return { manifest, deduplicated: true };
      } finally {
        encoded.fill(0);
      }
      this.verifyExistingArtifact(artifactPath, manifest);
      return { manifest, deduplicated: false };
    } finally {
      plaintext.fill(0);
    }
  }

  public read(manifestValue: unknown): Buffer {
    this.assertOpen();
    const manifest = parseArtifactManifest(manifestValue);
    this.assertSize(manifest.sizeBytes);
    const artifactPath = this.pathForValidatedManifest(manifest);
    return this.decryptStoredArtifact(artifactPath, manifest);
  }

  public artifactPath(manifestValue: unknown): string {
    this.assertOpen();
    const manifest = parseArtifactManifest(manifestValue);
    this.assertSize(manifest.sizeBytes);
    return this.pathForValidatedManifest(manifest);
  }

  public close(): void {
    if (this.closed) return;
    this.encryptionKey.fill(0);
    this.locatorKey.fill(0);
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Artifact vault is closed");
  }

  private assertSize(sizeBytes: number): void {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error("Artifact size must be a non-negative safe integer");
    }
    if (sizeBytes > this.maxArtifactBytes) {
      throw new Error(
        `Artifact size ${sizeBytes} exceeds configured maximum of ${this.maxArtifactBytes} bytes`
      );
    }
  }

  private storageLocator(contentHash: string): string {
    const digest = createHmac("sha256", this.locatorKey)
      .update(LOCATOR_DOMAIN)
      .update(contentHash, "utf8")
      .digest("hex");
    return `${LOCATOR_PREFIX}${digest}`;
  }

  private createManifest(content: Buffer): ArtifactManifest {
    const contentHash = sha256(content);
    const manifest: ArtifactManifest = {
      format: ARTIFACT_FORMAT,
      version: 1,
      cipher: CIPHER,
      contentHash,
      storageLocator: this.storageLocator(contentHash),
      sizeBytes: content.byteLength
    };
    assertArtifactManifest(manifest);
    return manifest;
  }

  private assertLocatorAuthentic(manifest: ArtifactManifest): void {
    const expected = Buffer.from(this.storageLocator(manifest.contentHash), "utf8");
    const actual = Buffer.from(manifest.storageLocator, "utf8");
    try {
      if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
        throw new Error("Artifact record cannot be authenticated with this vault key");
      }
    } finally {
      expected.fill(0);
      actual.fill(0);
    }
  }

  private pathForValidatedManifest(manifest: ArtifactManifest): string {
    this.assertLocatorAuthentic(manifest);
    const digest = manifest.storageLocator.slice(LOCATOR_PREFIX.length);
    const candidate = path.resolve(
      this.objectRoot,
      digest.slice(0, 2),
      `${digest.slice(2)}${ARTIFACT_EXTENSION}`
    );
    assertWithinRoot(this.vaultRoot, candidate);
    return candidate;
  }

  private assertStorageHierarchy(artifactPath: string, createShard: boolean): string {
    const canonicalObjectRoot = assertPlainDirectory(this.objectRoot, this.vaultRoot);
    if (canonicalObjectRoot !== this.objectRoot) {
      throw new Error("Artifact vault object directory changed unexpectedly");
    }
    const shardPath = path.dirname(artifactPath);
    assertWithinRoot(this.objectRoot, shardPath);
    let shardCreated = false;
    if (!existsSync(shardPath)) {
      if (!createShard) throw new Error("Artifact not found in the configured vault");
      mkdirSync(shardPath, { mode: 0o700 });
      shardCreated = true;
    }
    const canonicalShard = assertPlainDirectory(shardPath, this.vaultRoot);
    if (canonicalShard !== shardPath) {
      throw new Error("Artifact vault shard directory changed unexpectedly");
    }
    if (shardCreated) fsyncDirectory(canonicalObjectRoot);
    const canonicalArtifactPath = path.join(canonicalShard, path.basename(artifactPath));
    assertWithinRoot(this.vaultRoot, canonicalArtifactPath);
    return canonicalArtifactPath;
  }

  private encrypt(content: Buffer, manifest: ArtifactManifest): ArtifactEnvelope {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv(CIPHER, this.encryptionKey, nonce);
    cipher.setAAD(envelopeAad(manifest));
    const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
    try {
      return {
        format: ENVELOPE_FORMAT,
        version: 1,
        cipher: CIPHER,
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url")
      };
    } finally {
      ciphertext.fill(0);
      nonce.fill(0);
    }
  }

  private readEnvelope(artifactPath: string): ArtifactEnvelope {
    const canonicalPath = this.assertStorageHierarchy(artifactPath, false);
    const metadata = lstatSync(canonicalPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Artifact storage entry must be a regular file without symbolic links");
    }
    const realArtifactPath = realpathSync(canonicalPath);
    assertWithinRoot(this.vaultRoot, realArtifactPath);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(realArtifactPath, fsConstants.O_RDONLY | noFollow);
    try {
      const openedMetadata = fstatSync(descriptor);
      if (!openedMetadata.isFile()) throw new Error("Artifact storage entry is not a regular file");
      if (openedMetadata.size > this.maxEnvelopeBytes) {
        throw new Error("Encrypted artifact exceeds the configured maximum envelope size");
      }
      const raw = readBounded(
        descriptor,
        this.maxEnvelopeBytes,
        "Encrypted artifact exceeds the configured maximum envelope size"
      );
      try {
        if (raw.byteLength > this.maxEnvelopeBytes) {
          throw new Error("Encrypted artifact exceeds the configured maximum envelope size");
        }
        return parseEnvelope(raw);
      } finally {
        raw.fill(0);
      }
    } finally {
      closeSync(descriptor);
    }
  }

  private decryptStoredArtifact(artifactPath: string, manifest: ArtifactManifest): Buffer {
    const envelope = this.readEnvelope(artifactPath);
    const nonce = canonicalBase64Url(envelope.nonce, "nonce", NONCE_LENGTH);
    const tag = canonicalBase64Url(envelope.tag, "tag", TAG_LENGTH);
    const ciphertext = canonicalBase64Url(envelope.ciphertext, "ciphertext");
    try {
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv(CIPHER, this.encryptionKey, nonce);
        decipher.setAAD(envelopeAad(manifest));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new Error("Encrypted artifact cannot be authenticated with the supplied key and manifest");
      }
      if (plaintext.byteLength !== manifest.sizeBytes || sha256(plaintext) !== manifest.contentHash) {
        plaintext.fill(0);
        throw new Error("Decrypted artifact does not match its authenticated manifest");
      }
      return plaintext;
    } finally {
      nonce.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
    }
  }

  private verifyExistingArtifact(artifactPath: string, manifest: ArtifactManifest): void {
    const plaintext = this.decryptStoredArtifact(artifactPath, manifest);
    plaintext.fill(0);
  }

  private atomicWrite(artifactPath: string, content: Buffer): void {
    const canonicalPath = this.assertStorageHierarchy(artifactPath, true);
    const directoryPath = path.dirname(canonicalPath);
    const temporaryPath = path.join(
      directoryPath,
      `.${path.basename(canonicalPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    assertWithinRoot(this.vaultRoot, temporaryPath);

    let descriptor: number | null = null;
    let committed = false;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, content);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
        descriptor = null;
      }
      renameSync(temporaryPath, canonicalPath);
      committed = true;
      fsyncDirectory(directoryPath);
    } catch (error) {
      const failures: unknown[] = [error];
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch (closeError) {
          failures.push(closeError);
        }
        descriptor = null;
      }
      try {
        removeExactTemporaryFile(temporaryPath);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      const message = error instanceof Error ? error.message : String(error);
      const cause = failures.length === 1
        ? error
        : new AggregateError(failures, "Artifact atomic write cleanup encountered additional failures");
      throw new AtomicArtifactWriteError(`Artifact atomic write failed: ${message}`, cause, committed);
    }
  }
}
