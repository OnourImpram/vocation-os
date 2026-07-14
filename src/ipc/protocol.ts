import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { stableStringify } from "../hash.js";
import type { AuthorityOperation } from "@vocation-os/sdk";

export const MAX_IPC_FRAME_BYTES = 1024 * 1024;

export type { AuthorityOperation } from "@vocation-os/sdk";

export interface IpcRequest {
  type: "request";
  id: string;
  sequence: number;
  operation: AuthorityOperation;
  payload: unknown;
  mac: string;
}

export interface IpcResponse {
  type: "response";
  id: string;
  sequence: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  mac: string;
}

export interface HelloFrame {
  type: "hello";
  clientNonce: string;
}

export interface ChallengeFrame {
  type: "challenge";
  challengeId: string;
  serverNonce: string;
}

export interface AuthFrame {
  type: "auth";
  challengeId: string;
  proof: string;
}

export interface ReadyFrame {
  type: "ready";
  challengeId: string;
  mac: string;
}

export function randomNonce(): string {
  return randomBytes(32).toString("base64url");
}

function hmac(secret: string | Buffer, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

export function handshakeProof(
  ipcSecret: string,
  hello: HelloFrame,
  challenge: ChallengeFrame
): string {
  return hmac(ipcSecret, stableStringify({
    protocol: 1,
    clientNonce: hello.clientNonce,
    serverNonce: challenge.serverNonce,
    challengeId: challenge.challengeId
  }));
}

export function deriveSessionKey(
  ipcSecret: string,
  hello: HelloFrame,
  challenge: ChallengeFrame
): Buffer {
  return createHmac("sha256", ipcSecret)
    .update(stableStringify({
      purpose: "vocation-os-ipc-session-v1",
      clientNonce: hello.clientNonce,
      serverNonce: challenge.serverNonce,
      challengeId: challenge.challengeId
    }), "utf8")
    .digest();
}

export function readyMac(sessionKey: Buffer, challengeId: string): string {
  return hmac(sessionKey, stableStringify({ type: "ready", challengeId }));
}

export function requestMac(
  sessionKey: Buffer,
  request: Omit<IpcRequest, "mac">
): string {
  return hmac(sessionKey, stableStringify(request));
}

export function responseMac(
  sessionKey: Buffer,
  response: Omit<IpcResponse, "mac">
): string {
  return hmac(sessionKey, stableStringify(response));
}

export function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_IPC_FRAME_BYTES) throw new Error("IPC frame exceeds the maximum size");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameChannel {
  private buffer = Buffer.alloc(0);
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure: Error | null = null;

  public constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.accept(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("IPC connection closed")));
  }

  private accept(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_IPC_FRAME_BYTES) {
        this.fail(new Error("IPC frame exceeds the maximum size"));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        this.deliver(JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        this.fail(new Error("IPC frame contains invalid JSON"));
        this.socket.destroy();
        return;
      }
    }
  }

  private deliver(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.queue.push(value);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  public send(value: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const frame = encodeFrame(value);
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  public async receive(timeoutMs = 5000): Promise<unknown> {
    if (this.queue.length > 0) return this.queue.shift();
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("IPC receive timed out"));
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      const originalReject = waiter.reject;
      waiter.resolve = (value) => {
        clearTimeout(timer);
        originalResolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        originalReject(error);
      };
    });
  }
}
