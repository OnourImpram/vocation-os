import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify
} from "node:crypto";
import { sha256, stableStringify } from "../hash.js";
import type { EncryptedEventStore, SignedCheckpointRecord } from "../storage/encrypted-event-store.js";
import {
  CREDENTIAL_ACCOUNTS,
  type CredentialStore
} from "./credential-store.js";

const CHECKPOINT_GENESIS = sha256("vocation-os:checkpoint-chain:v1");

function signingPayload(record: Omit<SignedCheckpointRecord, "signature">): string {
  return stableStringify(record);
}

export function checkpointDigest(record: SignedCheckpointRecord): string {
  return sha256(stableStringify(record));
}

async function loadOrCreatePrivateKey(store: CredentialStore): Promise<string> {
  const existing = await store.get(CREDENTIAL_ACCOUNTS.checkpointPrivateKey);
  if (existing) {
    try {
      createPrivateKey(existing);
      return existing;
    } catch {
      throw new Error("Checkpoint private key in the credential store is invalid");
    }
  }
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await store.set(CREDENTIAL_ACCOUNTS.checkpointPrivateKey, privateKeyPem);
  const verified = await store.get(CREDENTIAL_ACCOUNTS.checkpointPrivateKey);
  if (verified !== privateKeyPem) throw new Error("Checkpoint private key failed read after write verification");
  return privateKeyPem;
}

async function loadOrCreateDeviceId(store: CredentialStore): Promise<string> {
  const existing = await store.get(CREDENTIAL_ACCOUNTS.deviceId);
  if (existing) {
    if (!/^DEV-[0-9a-f-]{36}$/.test(existing)) throw new Error("Credential store device id is invalid");
    return existing;
  }
  const deviceId = `DEV-${randomUUID()}`;
  await store.set(CREDENTIAL_ACCOUNTS.deviceId, deviceId);
  if (await store.get(CREDENTIAL_ACCOUNTS.deviceId) !== deviceId) {
    throw new Error("Device id failed read after write verification");
  }
  return deviceId;
}

export interface CheckpointVerification {
  valid: true;
  checkpointCount: number;
  latestDigest: string | null;
  externalDigestMatched: boolean;
}

export interface CheckpointRecordVerification {
  valid: true;
  checkpointCount: number;
  latestDigest: string | null;
}

export async function verifyCheckpointRecords(
  eventStore: EncryptedEventStore
): Promise<CheckpointRecordVerification> {
  const checkpoints = eventStore.listSignedCheckpoints();
  let expectedPrevious = CHECKPOINT_GENESIS;
  let previousEventCount = -1;
  for (const checkpoint of checkpoints) {
    if (checkpoint.previousCheckpointDigest !== expectedPrevious) {
      throw new Error(`Checkpoint chain is broken at ${checkpoint.checkpointId}`);
    }
    if (checkpoint.eventCount < previousEventCount) {
      throw new Error(`Checkpoint event count regressed at ${checkpoint.checkpointId}`);
    }
    const { signature, ...unsigned } = checkpoint;
    const signatureValid = verify(
      null,
      Buffer.from(signingPayload(unsigned), "utf8"),
      createPublicKey(checkpoint.publicKeyPem),
      Buffer.from(signature, "base64url")
    );
    if (!signatureValid) throw new Error(`Checkpoint signature is invalid at ${checkpoint.checkpointId}`);
    expectedPrevious = checkpointDigest(checkpoint);
    previousEventCount = checkpoint.eventCount;
  }

  const latestDigest = checkpoints.length > 0 ? expectedPrevious : null;
  const currentHead = await eventStore.chainHead();
  const latest = checkpoints.at(-1);
  if (latest && (
    latest.databaseId !== await eventStore.databaseId()
    || latest.eventCount > currentHead.eventCount
    || (latest.eventCount === currentHead.eventCount && latest.headHash !== currentHead.headHash)
  )) {
    throw new Error("Latest signed checkpoint is incompatible with the current event chain");
  }
  return {
    valid: true,
    checkpointCount: checkpoints.length,
    latestDigest
  };
}

export async function verifyCheckpointChain(
  eventStore: EncryptedEventStore,
  credentialStore: CredentialStore
): Promise<CheckpointVerification> {
  const records = await verifyCheckpointRecords(eventStore);
  const externalDigest = await credentialStore.get(CREDENTIAL_ACCOUNTS.latestCheckpointDigest);
  if (externalDigest !== records.latestDigest) {
    throw new Error("Database checkpoint does not match the latest digest retained in the credential store");
  }
  return { ...records, externalDigestMatched: true };
}

export async function createSignedCheckpoint(
  eventStore: EncryptedEventStore,
  credentialStore: CredentialStore,
  now = new Date(),
  checkpointId = `CHK-${randomUUID()}`
): Promise<SignedCheckpointRecord> {
  await verifyCheckpointChain(eventStore, credentialStore);
  const existing = eventStore.listSignedCheckpoints();
  const replay = existing.find((checkpoint) => checkpoint.checkpointId === checkpointId);
  if (replay) return replay;
  const head = await eventStore.chainHead();
  const previous = existing.at(-1);
  if (previous && previous.eventCount === head.eventCount && previous.headHash === head.headHash) {
    throw new Error("Checkpoint requires event chain advancement");
  }
  const privateKeyPem = await loadOrCreatePrivateKey(credentialStore);
  const publicKeyPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  const keyId = `KEY-${sha256(publicKeyPem).slice("sha256:".length, "sha256:".length + 24)}`;
  const unsigned: Omit<SignedCheckpointRecord, "signature"> = {
    checkpointId,
    databaseId: await eventStore.databaseId(),
    schemaVersion: eventStore.migrations().at(-1)?.version ?? 0,
    eventCount: head.eventCount,
    headHash: head.headHash,
    createdAt: now.toISOString(),
    deviceId: await loadOrCreateDeviceId(credentialStore),
    keyId,
    previousCheckpointDigest: previous ? checkpointDigest(previous) : CHECKPOINT_GENESIS,
    publicKeyPem
  };
  if (unsigned.schemaVersion < 1) throw new Error("Cannot checkpoint a store without a migration version");
  const checkpoint: SignedCheckpointRecord = {
    ...unsigned,
    signature: sign(null, Buffer.from(signingPayload(unsigned), "utf8"), createPrivateKey(privateKeyPem)).toString("base64url")
  };
  eventStore.saveSignedCheckpoint(checkpoint);
  await credentialStore.set(CREDENTIAL_ACCOUNTS.latestCheckpointDigest, checkpointDigest(checkpoint));
  await verifyCheckpointChain(eventStore, credentialStore);
  return checkpoint;
}
