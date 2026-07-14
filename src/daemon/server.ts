import { createServer, type Server, type Socket } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { daemonEndpointReachable } from "../ipc/client.js";
import {
  FrameChannel,
  deriveSessionKey,
  handshakeProof,
  randomNonce,
  readyMac,
  requestMac,
  responseMac,
  secureEqual,
  type AuthFrame,
  type HelloFrame,
  type IpcRequest,
  type IpcResponse
} from "../ipc/protocol.js";
import { acquireSingleInstanceLock, type SingleInstanceLock } from "../runtime/single-instance.js";
import type { RuntimeAuthority } from "./authority.js";

function isHello(value: unknown): value is HelloFrame {
  const frame = value as Partial<HelloFrame>;
  return frame?.type === "hello"
    && typeof frame.clientNonce === "string"
    && /^[A-Za-z0-9_-]{32,100}$/.test(frame.clientNonce);
}

function isAuth(value: unknown): value is AuthFrame {
  const frame = value as Partial<AuthFrame>;
  return frame?.type === "auth"
    && typeof frame.challengeId === "string"
    && typeof frame.proof === "string";
}

function isRequest(value: unknown): value is IpcRequest {
  const frame = value as Partial<IpcRequest>;
  return frame?.type === "request"
    && typeof frame.id === "string"
    && Number.isInteger(frame.sequence)
    && typeof frame.operation === "string"
    && "payload" in frame
    && typeof frame.mac === "string";
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export interface DaemonServerHandle {
  endpoint: string;
  shutdownRequested: Promise<void>;
  close(): Promise<void>;
}

export async function startDaemonServer(input: {
  endpoint: string;
  lockPath: string;
  ipcSecret: string;
  authority: RuntimeAuthority;
  maxConnections?: number;
  maxPendingHandshakes?: number;
  handshakeTimeoutMs?: number;
  instanceLock?: SingleInstanceLock;
}): Promise<DaemonServerHandle> {
  const maxConnections = input.maxConnections ?? 32;
  const maxPendingHandshakes = input.maxPendingHandshakes ?? Math.max(8, Math.min(32, maxConnections));
  const handshakeTimeoutMs = input.handshakeTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new Error("Daemon authenticated connection limit must be a positive integer");
  }
  if (!Number.isSafeInteger(maxPendingHandshakes) || maxPendingHandshakes < 1) {
    throw new Error("Daemon pending handshake limit must be a positive integer");
  }
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 100 || handshakeTimeoutMs > 30_000) {
    throw new Error("Daemon handshake timeout must be between 100 and 30000 milliseconds");
  }
  const ownsLock = input.instanceLock === undefined;
  const lock = input.instanceLock ?? await acquireSingleInstanceLock({
      lockPath: input.lockPath,
      endpoint: input.endpoint,
      endpointReachable: daemonEndpointReachable
    });
  try {
    if (process.platform !== "win32" && existsSync(input.endpoint)) {
      if (await daemonEndpointReachable(input.endpoint)) {
        throw new Error("Daemon endpoint is already reachable. Refusing to replace an active socket");
      }
      rmSync(input.endpoint);
    }
  } catch (error) {
    if (ownsLock) lock.release();
    throw error;
  }
  const sockets = new Set<Socket>();
  let pendingHandshakes = 0;
  let authenticatedConnections = 0;
  let authorityQueue: Promise<unknown> = Promise.resolve();
  let resolveShutdownRequest: (() => void) | null = null;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdownRequest = resolve;
  });
  const dispatch = (request: IpcRequest): Promise<unknown> => {
    const execution = authorityQueue.then(() => input.authority.execute({
      id: request.id,
      operation: request.operation,
      payload: request.payload
    }));
    authorityQueue = execution.then(() => undefined, () => undefined);
    return execution;
  };

  const server = createServer((socket) => {
    if (
      authenticatedConnections >= maxConnections
      || pendingHandshakes >= maxPendingHandshakes
      || sockets.size >= maxConnections + maxPendingHandshakes
    ) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    pendingHandshakes += 1;
    let connectionPhase: "pending" | "authenticated" | "closed" = "pending";
    socket.setNoDelay(true);
    socket.once("close", () => {
      sockets.delete(socket);
      if (connectionPhase === "pending") pendingHandshakes -= 1;
      if (connectionPhase === "authenticated") authenticatedConnections -= 1;
      connectionPhase = "closed";
    });
    const channel = new FrameChannel(socket);
    void (async () => {
      let sessionKey: Buffer | null = null;
      try {
        const helloValue = await channel.receive(handshakeTimeoutMs);
        if (!isHello(helloValue)) throw new Error("Invalid IPC hello frame");
        const challenge = {
          type: "challenge" as const,
          challengeId: `CHL-${randomUUID()}`,
          serverNonce: randomNonce()
        };
        await channel.send(challenge);
        const authValue = await channel.receive(handshakeTimeoutMs);
        if (!isAuth(authValue) || authValue.challengeId !== challenge.challengeId) {
          throw new Error("Invalid IPC authentication frame");
        }
        if (!secureEqual(authValue.proof, handshakeProof(input.ipcSecret, helloValue, challenge))) {
          throw new Error("IPC authentication failed");
        }
        if (authenticatedConnections >= maxConnections) {
          throw new Error("Daemon authenticated connection capacity is exhausted");
        }
        pendingHandshakes -= 1;
        authenticatedConnections += 1;
        connectionPhase = "authenticated";
        sessionKey = deriveSessionKey(input.ipcSecret, helloValue, challenge);
        await channel.send({
          type: "ready",
          challengeId: challenge.challengeId,
          mac: readyMac(sessionKey, challenge.challengeId)
        });

        let expectedSequence = 1;
        while (!socket.destroyed) {
          const requestValue = await channel.receive(30_000);
          if (!isRequest(requestValue)) throw new Error("Invalid IPC request frame");
          const { mac, ...unsignedRequest } = requestValue;
          if (
            requestValue.sequence !== expectedSequence
            || !secureEqual(mac, requestMac(sessionKey, unsignedRequest))
          ) {
            throw new Error("IPC request sequence or MAC is invalid");
          }
          expectedSequence += 1;
          let responseBody: Omit<IpcResponse, "mac">;
          try {
            responseBody = {
              type: "response",
              id: requestValue.id,
              sequence: requestValue.sequence,
              ok: true,
              result: await dispatch(requestValue)
            };
          } catch (error) {
            responseBody = {
              type: "response",
              id: requestValue.id,
              sequence: requestValue.sequence,
              ok: false,
              error: error instanceof Error ? error.message : "Authority operation failed"
            };
          }
          await channel.send({ ...responseBody, mac: responseMac(sessionKey, responseBody) });
          if (responseBody.ok && requestValue.operation === "daemon-stop") {
            resolveShutdownRequest?.();
            socket.end();
            break;
          }
        }
      } catch {
        socket.destroy();
      } finally {
        sessionKey?.fill(0);
      }
    })();
  });

  try {
    await listen(server, input.endpoint);
  } catch (error) {
    if (ownsLock) lock.release();
    throw error;
  }

  return {
    endpoint: input.endpoint,
    shutdownRequested,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      if (process.platform !== "win32" && existsSync(input.endpoint)) rmSync(input.endpoint);
      lock.release();
    }
  };
}
