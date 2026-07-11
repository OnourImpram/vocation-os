import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeAuthority } from "../../src/daemon/authority.js";
import { startDaemonServer, type DaemonServerHandle } from "../../src/daemon/server.js";
import { callAuthority } from "../../src/ipc/client.js";
import {
  FrameChannel,
  deriveSessionKey,
  handshakeProof,
  randomNonce,
  requestMac,
  type ChallengeFrame,
  type HelloFrame,
  type IpcRequest
} from "../../src/ipc/protocol.js";
import { MemoryCredentialStore } from "../../src/security/credential-store.js";
import { EncryptedEventStore } from "../../src/storage/encrypted-event-store.js";

const STORE_PASSPHRASE = "ipc daemon test passphrase";

function endpointFor(dir: string): string {
  const suffix = `${process.pid}-${randomUUID()}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\vocation-os-test-${suffix}`
    : path.join(dir, `daemon-${suffix}.sock`);
}

function openSocket(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function authenticatedChannel(endpoint: string, secret: string): Promise<{
  socket: Socket;
  channel: FrameChannel;
  sessionKey: Buffer;
}> {
  const socket = await openSocket(endpoint);
  const channel = new FrameChannel(socket);
  const hello: HelloFrame = { type: "hello", clientNonce: randomNonce() };
  await channel.send(hello);
  const challenge = await channel.receive(1_000) as ChallengeFrame;
  const sessionKey = deriveSessionKey(secret, hello, challenge);
  await channel.send({
    type: "auth",
    challengeId: challenge.challengeId,
    proof: handshakeProof(secret, hello, challenge)
  });
  await channel.receive(1_000);
  return { socket, channel, sessionKey };
}

describe("authenticated daemon IPC", () => {
  let dir: string;
  let endpoint: string;
  let secret: string;
  let store: EncryptedEventStore | undefined;
  let server: DaemonServerHandle | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vocation-ipc-"));
    endpoint = endpointFor(dir);
    secret = randomBytes(32).toString("base64url");
    store = await EncryptedEventStore.open(path.join(dir, "vocation.db"), STORE_PASSPHRASE);
    const authority = new RuntimeAuthority(store, new MemoryCredentialStore(), dir);
    server = await startDaemonServer({
      endpoint,
      lockPath: path.join(dir, "vocationd.lock"),
      ipcSecret: secret,
      authority
    });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    if (store) {
      await store.close();
      store = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns health only after successful authentication", async () => {
    const health = await callAuthority({
      endpoint,
      ipcSecret: secret,
      operation: "health",
      requestId: "REQ-IPC-HEALTH-0001",
      timeoutMs: 2_000
    });

    expect(health).toMatchObject({
      status: "ok",
      eventCount: 0,
      compiledAdapters: expect.any(Array)
    });
    expect(health).toHaveProperty("databaseId");
    expect(health).toHaveProperty("migrations");
  });

  it("rejects a client using the wrong IPC secret", async () => {
    await expect(callAuthority({
      endpoint,
      ipcSecret: randomBytes(32).toString("base64url"),
      operation: "health",
      requestId: "REQ-IPC-WRONG-SECRET-0001",
      timeoutMs: 1_000
    })).rejects.toThrow();
  });

  it("closes an unauthenticated client that sends a request frame first", async () => {
    const socket = await openSocket(endpoint);
    const channel = new FrameChannel(socket);
    try {
      await channel.send({
        type: "request",
        id: "REQ-IPC-NO-AUTH-0001",
        sequence: 1,
        operation: "health",
        payload: {},
        mac: "not-authenticated"
      });
      await expect(channel.receive(1_000)).rejects.toThrow();
    } finally {
      socket.destroy();
    }
  });

  it("rejects a request with a tampered MAC", async () => {
    const { socket, channel, sessionKey } = await authenticatedChannel(endpoint, secret);
    try {
      const unsigned: Omit<IpcRequest, "mac"> = {
        type: "request",
        id: "REQ-IPC-TAMPERED-MAC-0001",
        sequence: 1,
        operation: "health",
        payload: {}
      };
      await channel.send({ ...unsigned, mac: `${requestMac(sessionKey, unsigned)}tampered` });
      await expect(channel.receive(1_000)).rejects.toThrow();
    } finally {
      sessionKey.fill(0);
      socket.destroy();
    }
  });

  it("rejects replay of an already accepted request sequence", async () => {
    const { socket, channel, sessionKey } = await authenticatedChannel(endpoint, secret);
    try {
      const unsigned: Omit<IpcRequest, "mac"> = {
        type: "request",
        id: "REQ-IPC-SEQUENCE-0001",
        sequence: 1,
        operation: "health",
        payload: {}
      };
      const request: IpcRequest = { ...unsigned, mac: requestMac(sessionKey, unsigned) };
      await channel.send(request);
      await expect(channel.receive(1_000)).resolves.toMatchObject({
        type: "response",
        id: request.id,
        sequence: 1,
        ok: true
      });

      await channel.send(request);
      await expect(channel.receive(1_000)).rejects.toThrow();
    } finally {
      sessionKey.fill(0);
      socket.destroy();
    }
  });
});
