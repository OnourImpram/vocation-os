import { describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_OPERATIONS,
  VocationClient,
  type VocationTransport
} from "../../packages/sdk/src/index.js";

describe("typed daemon SDK boundary", () => {
  it("exposes each daemon authority operation from one canonical list", () => {
    expect(new Set(AUTHORITY_OPERATIONS).size).toBe(AUTHORITY_OPERATIONS.length);
    expect(AUTHORITY_OPERATIONS).toContain("health");
    expect(AUTHORITY_OPERATIONS).toContain("auto-apply-evaluate");
  });

  it("preserves request identity and timeout metadata through the transport", async () => {
    const execute = vi.fn(async () => ({ status: "ok" }));
    const transport: VocationTransport = { execute };
    const client = new VocationClient(transport);

    await expect(client.request("health", {}, {
      requestId: "REQ-SDK-HEALTH-0001",
      timeoutMs: 2_500
    })).resolves.toEqual({ status: "ok" });
    expect(execute).toHaveBeenCalledWith({
      operation: "health",
      payload: {},
      requestId: "REQ-SDK-HEALTH-0001",
      timeoutMs: 2_500
    });
  });
});
