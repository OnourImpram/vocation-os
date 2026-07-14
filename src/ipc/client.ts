import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
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
  type AuthorityOperation,
  type ChallengeFrame,
  type HelloFrame,
  type IpcRequest,
  type IpcResponse,
  type ReadyFrame
} from "./protocol.js";

function openSocket(endpoint: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Daemon connection timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isChallenge(value: unknown): value is ChallengeFrame {
  const frame = value as Partial<ChallengeFrame>;
  return frame?.type === "challenge"
    && typeof frame.challengeId === "string"
    && typeof frame.serverNonce === "string";
}

function isReady(value: unknown): value is ReadyFrame {
  const frame = value as Partial<ReadyFrame>;
  return frame?.type === "ready"
    && typeof frame.challengeId === "string"
    && typeof frame.mac === "string";
}

function isResponse(value: unknown): value is IpcResponse {
  const frame = value as Partial<IpcResponse>;
  return frame?.type === "response"
    && typeof frame.id === "string"
    && Number.isInteger(frame.sequence)
    && typeof frame.ok === "boolean"
    && typeof frame.mac === "string";
}

function defaultOperationTimeoutMs(operation: AuthorityOperation): number {
  switch (operation) {
    case "profile-import-plan":
      return 45_000;
    case "legacy-import-apply":
      return 120_000;
    case "artifact-import":
    case "profile-import-apply":
    case "audit-export":
    case "checkpoint-create":
      return 30_000;
    default:
      return 5_000;
  }
}

export async function daemonEndpointReachable(endpoint: string, timeoutMs = 250): Promise<boolean> {
  try {
    const socket = await openSocket(endpoint, timeoutMs);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

export async function callAuthority(input: {
  endpoint: string;
  ipcSecret: string;
  operation: AuthorityOperation;
  payload?: unknown;
  requestId?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const timeoutMs = input.timeoutMs ?? defaultOperationTimeoutMs(input.operation);
  const handshakeTimeoutMs = Math.min(timeoutMs, 5_000);
  const requestId = input.requestId ?? `REQ-${randomUUID()}`;
  const socket = await openSocket(input.endpoint, handshakeTimeoutMs);
  const channel = new FrameChannel(socket);
  let sessionKey: Buffer | null = null;
  try {
    const hello: HelloFrame = { type: "hello", clientNonce: randomNonce() };
    await channel.send(hello);
    const challengeValue = await channel.receive(handshakeTimeoutMs);
    if (!isChallenge(challengeValue)) throw new Error("Daemon returned an invalid challenge");
    const auth: AuthFrame = {
      type: "auth",
      challengeId: challengeValue.challengeId,
      proof: handshakeProof(input.ipcSecret, hello, challengeValue)
    };
    sessionKey = deriveSessionKey(input.ipcSecret, hello, challengeValue);
    await channel.send(auth);
    const readyValue = await channel.receive(handshakeTimeoutMs);
    if (!isReady(readyValue) || readyValue.challengeId !== challengeValue.challengeId) {
      throw new Error("Daemon authentication acknowledgement is invalid");
    }
    if (!secureEqual(readyValue.mac, readyMac(sessionKey, readyValue.challengeId))) {
      throw new Error("Daemon authentication acknowledgement MAC is invalid");
    }

    const unsigned: Omit<IpcRequest, "mac"> = {
      type: "request",
      id: requestId,
      sequence: 1,
      operation: input.operation,
      payload: input.payload ?? {}
    };
    const request: IpcRequest = { ...unsigned, mac: requestMac(sessionKey, unsigned) };
    await channel.send(request);
    let responseValue: unknown;
    try {
      responseValue = await channel.receive(timeoutMs);
    } catch (error) {
      if (error instanceof Error && error.message === "IPC receive timed out") {
        throw new Error(
          `Authority response timed out for request ${requestId}. Retry with the same request id to recover the canonical result`
        );
      }
      throw error;
    }
    if (!isResponse(responseValue)) throw new Error("Daemon returned an invalid response");
    const { mac, ...unsignedResponse } = responseValue;
    if (
      responseValue.id !== request.id
      || responseValue.sequence !== request.sequence
      || !secureEqual(mac, responseMac(sessionKey, unsignedResponse))
    ) {
      throw new Error("Daemon response binding is invalid");
    }
    if (!responseValue.ok) throw new Error(responseValue.error ?? "Daemon authority operation failed");
    return responseValue.result;
  } finally {
    sessionKey?.fill(0);
    socket.destroy();
  }
}
