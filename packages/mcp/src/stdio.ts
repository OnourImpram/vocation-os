import type { Readable, Writable } from "node:stream";
import {
  protocolError,
  type JsonRpcResponse,
  type McpProtocolServer
} from "./server.js";

export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
export const HARD_MAX_REQUEST_BYTES = 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT = 16;

export interface McpStdioOptions {
  input?: Readable;
  output?: Writable;
  maxRequestBytes?: number;
  maxInFlight?: number;
}

class JsonLineWriter {
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly output: Writable) {}

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        this.output.off("error", onError);
      };
      this.output.once("error", onError);
      this.output.write(line, "utf8", () => {
        cleanup();
        resolve();
      });
    });
  }

  public write(response: JsonRpcResponse): Promise<void> {
    const line = `${JSON.stringify(response)}\n`;
    const next = this.tail.then(() => this.writeLine(line));
    this.tail = next;
    return next;
  }

  public flush(): Promise<void> {
    return this.tail;
  }
}

function trimCarriageReturn(frame: Buffer): Buffer {
  return frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame;
}

function chunkBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new TypeError("MCP stdin emitted an unsupported chunk type");
}

export async function runMcpStdio(
  server: McpProtocolServer,
  options: McpStdioOptions = {}
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  if (
    !Number.isSafeInteger(maxRequestBytes)
    || maxRequestBytes < 1_024
    || maxRequestBytes > HARD_MAX_REQUEST_BYTES
  ) {
    throw new TypeError("MCP request limit must be between 1024 and 1048576 bytes");
  }
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) {
    throw new TypeError("MCP in-flight limit must be between 1 and 64");
  }

  const writer = new JsonLineWriter(output);
  const inFlight = new Set<Promise<void>>();
  let fatalError: unknown;

  const schedule = (response: Promise<JsonRpcResponse | null>): void => {
    let task: Promise<void>;
    task = response
      .then((message) => message === null ? undefined : writer.write(message))
      .then(() => undefined)
      .catch((error: unknown) => {
        fatalError ??= error;
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  const backpressure = async (): Promise<void> => {
    if (inFlight.size >= maxInFlight) await Promise.race(inFlight);
    if (fatalError !== undefined) throw fatalError;
  };

  const frames: Buffer[] = [];
  let frameBytes = 0;
  let discardingOversizeFrame = false;

  const resetFrame = (): void => {
    frames.length = 0;
    frameBytes = 0;
    discardingOversizeFrame = false;
  };

  const append = (segment: Buffer): void => {
    if (discardingOversizeFrame || segment.length === 0) return;
    if (frameBytes + segment.length > maxRequestBytes) {
      frames.length = 0;
      frameBytes = 0;
      discardingOversizeFrame = true;
      schedule(Promise.resolve(protocolError(null, -32000, "Request too large")));
      return;
    }
    frames.push(segment);
    frameBytes += segment.length;
  };

  const dispatchFrame = (): void => {
    if (!discardingOversizeFrame) {
      const frame = trimCarriageReturn(Buffer.concat(frames, frameBytes));
      schedule(server.handleFrame(frame));
    }
    resetFrame();
  };

  for await (const rawChunk of input) {
    const chunk = chunkBuffer(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      append(chunk.subarray(offset, end));
      if (newline < 0) {
        offset = chunk.length;
      } else {
        dispatchFrame();
        offset = newline + 1;
      }
      await backpressure();
    }
  }

  if (!discardingOversizeFrame && frameBytes > 0) dispatchFrame();
  await Promise.all(inFlight);
  if (fatalError !== undefined) throw fatalError;
  await writer.flush();
}
