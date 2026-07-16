import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_CLIENT_IDS,
  INTEGRATION_MANIFEST_FILES,
  validateIntegrationManifest
} from "../src/index.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("portable agent skill", () => {
  it("validates one thin manifest for every required client", async () => {
    const manifests = await Promise.all(AGENT_CLIENT_IDS.map(async (clientId) => {
      const filename = INTEGRATION_MANIFEST_FILES[clientId];
      const value = JSON.parse(await readFile(join(PACKAGE_ROOT, "integrations", filename), "utf8")) as unknown;
      return validateIntegrationManifest(value);
    }));

    expect(manifests.map((manifest) => manifest.clientId)).toEqual(AGENT_CLIENT_IDS);
    expect(manifests.every((manifest) => manifest.authority.directStorage === false)).toBe(true);
  });

  it("ships an Open Agent Skills entrypoint with the required metadata", async () => {
    const skill = await readFile(join(PACKAGE_ROOT, "skill", "vocation-os", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: vocation-os\n")).toBe(true);
    expect(skill).toContain("description:");
    expect(skill).toContain("Never read or write VocationOS storage directly.");
  });
});
