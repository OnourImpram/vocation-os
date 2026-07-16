import { describe, expect, it } from "vitest";
import {
  ProviderContractError,
  defineProviderDescriptor,
  defineProviderPage
} from "../src/index.js";

describe("provider SDK contracts", () => {
  it("accepts a broker-mediated provider descriptor", () => {
    const descriptor = defineProviderDescriptor({
      id: "example-jobs",
      displayName: "Example Jobs",
      version: "1.0.0",
      kind: "job-board",
      supportLevel: "invocable",
      capabilities: ["discover-opportunities", "health-check"],
      baseUrls: ["https://jobs.example.com/api"]
    });

    expect(descriptor.id).toBe("example-jobs");
    expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
  });

  it("rejects insecure provider origins and inconsistent pagination", () => {
    expect(() => defineProviderDescriptor({
      id: "insecure",
      displayName: "Insecure",
      version: "1.0.0",
      kind: "search",
      supportLevel: "discovered",
      capabilities: ["discover-opportunities"],
      baseUrls: ["http://example.com"]
    })).toThrow(ProviderContractError);

    expect(() => defineProviderPage({
      items: [],
      requestId: "REQ-PROVIDER-1",
      nextCursor: null,
      hasMore: true
    })).toThrow("must include a next cursor");
  });
});
