import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_CLIENT_IDS,
  INTEGRATION_MANIFEST_FILES,
  validateIntegrationManifest
} from "../../packages/agent-skill/src/index.js";
import { verifyBundle } from "../../packages/installer/src/index.js";
import {
  READ_ONLY_TOOLS,
  SIDE_EFFECT_TOOLS,
  createMcpToolCatalog
} from "../../packages/mcp/src/index.js";
import { defineProviderDescriptor } from "../../packages/provider-sdk/src/index.js";
import { createQueueActions, type QueueItem } from "../../packages/tui/src/index.js";
import {
  WORKBENCH_ROUTES,
  validateLoopbackOrigin
} from "../../packages/workbench/src/index.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_NAMES = [
  "tui",
  "workbench",
  "mcp",
  "agent-skill",
  "provider-sdk",
  "installer"
] as const;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readTypeScriptTree(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) chunks.push(await readTypeScriptTree(path));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) chunks.push(await readFile(path, "utf8"));
  }
  return chunks.join("\n");
}

describe("v0.6 workspace package contracts", () => {
  it("ships independently typecheckable packages with bounded runtime dependencies", async () => {
    const dependencyAllowlist: Readonly<Record<(typeof PACKAGE_NAMES)[number], readonly string[]>> = {
      tui: ["ink", "react"],
      workbench: ["lucide-react", "react", "react-dom"],
      mcp: [],
      "agent-skill": [],
      "provider-sdk": [],
      installer: []
    };
    for (const packageName of PACKAGE_NAMES) {
      const manifest = await readJson(join(REPOSITORY_ROOT, "packages", packageName, "package.json"));
      expect(manifest).toMatchObject({
        name: `@vocation-os/${packageName}`,
        private: true,
        sideEffects: false,
        scripts: {
          typecheck: "tsc -p tsconfig.json --noEmit"
        }
      });
      const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {};
      expect(Object.keys(dependencies).sort()).toEqual([...dependencyAllowlist[packageName]].sort());
    }
  });

  it("keeps TUI and workbench outside storage and adapter authority", async () => {
    for (const packageName of ["tui", "workbench"] as const) {
      const source = await readTypeScriptTree(join(REPOSITORY_ROOT, "packages", packageName, "src"));
      expect(source).not.toMatch(/node:fs|better-sqlite3|application-tracker|storage\//u);
      expect(source).not.toMatch(/\.\.\/\.\.\/src\//u);
    }

    const tuiApp = await readFile(join(REPOSITORY_ROOT, "packages", "tui", "src", "app.tsx"), "utf8");
    expect(tuiApp).toContain("useInput");
    expect(tuiApp).toContain("EvidencePanel");
    expect(tuiApp).toContain("ActionsPanel");
    const workbenchApp = await readFile(join(REPOSITORY_ROOT, "packages", "workbench", "src", "app.tsx"), "utf8");
    expect(workbenchApp).toContain("WORKBENCH_ROUTES");
    expect(workbenchApp).toContain("client.read<WorkbenchRoutePayload>");

    const approved: QueueItem = {
      attemptId: "ATTEMPT-CONTRACT",
      opportunityId: "OPPORTUNITY-CONTRACT",
      title: "Role",
      organization: "Organization",
      status: "approved",
      priority: "normal",
      updatedAt: "2026-07-14T00:00:00.000Z",
      version: 2,
      blocker: null
    };
    const actions = createQueueActions(approved);
    expect(actions.map((action) => action.id)).toEqual(["inspect", "mark-blocked"]);
    expect(actions.some((action) => action.command?.kind.includes("submission"))).toBe(false);
  });

  it("exposes every required workbench route through a strict loopback boundary", () => {
    expect(WORKBENCH_ROUTES.map((route) => route.title)).toEqual([
      "Today",
      "Discovery",
      "Review",
      "Twin",
      "Documents",
      "Pipeline",
      "Evidence",
      "Approvals",
      "Audit",
      "Credentials",
      "Interview",
      "Offers",
      "Settings"
    ]);
    expect(validateLoopbackOrigin("http://127.0.0.1:43117/").origin)
      .toBe("http://127.0.0.1:43117");
    expect(() => validateLoopbackOrigin("https://vocation.example:443/"))
      .toThrow("explicit loopback host");
  });

  it("defaults MCP to reads and gates every declared side effect", () => {
    expect(createMcpToolCatalog()).toEqual(READ_ONLY_TOOLS);
    expect(READ_ONLY_TOOLS.every((tool) => (
      tool.security.effect === "read"
      && tool.annotations.readOnlyHint === true
      && tool.security.approvalRequired === false
    ))).toBe(true);
    expect(SIDE_EFFECT_TOOLS.every((tool) => (
      tool.security.effect === "side-effect"
      && tool.annotations.readOnlyHint === false
      && tool.security.requiredCapability !== null
      && tool.security.approvalRequired
    ))).toBe(true);
  });

  it("ships the Open Agent Skill and all required thin client manifests", async () => {
    const packageRoot = join(REPOSITORY_ROOT, "packages", "agent-skill");
    const manifests = await Promise.all(AGENT_CLIENT_IDS.map(async (clientId) => {
      const manifest = await readJson(join(
        packageRoot,
        "integrations",
        INTEGRATION_MANIFEST_FILES[clientId]
      ));
      return validateIntegrationManifest(manifest);
    }));
    expect(manifests.map((manifest) => manifest.clientId)).toEqual(AGENT_CLIENT_IDS);

    const skill = await readFile(join(packageRoot, "skill", "vocation-os", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: vocation-os\n")).toBe(true);
    expect(skill.match(/^description: (.+)$/mu)?.[1]?.length).toBeGreaterThan(0);
    expect(skill.split(/\r?\n/u).length).toBeLessThan(500);
  });

  it("verifies the checked in agent bundle checksum manifest", async () => {
    const packageRoot = join(REPOSITORY_ROOT, "packages", "agent-skill");
    const manifest = await readJson(join(packageRoot, "checksums.json"));
    const receipt = await verifyBundle({ bundleRoot: packageRoot, manifest });

    expect(receipt.algorithm).toBe("sha256");
    expect(receipt.files).toHaveLength(AGENT_CLIENT_IDS.length + 1);

    const installerSource = await readTypeScriptTree(join(REPOSITORY_ROOT, "packages", "installer", "src"));
    expect(installerSource).not.toMatch(/node:child_process|curl\s|wget\s|Invoke-WebRequest|\|\s*(?:sh|bash|pwsh)/u);
  });

  it("keeps provider network access behind the typed fetch broker contract", () => {
    const descriptor = defineProviderDescriptor({
      id: "workspace-contract-provider",
      displayName: "Workspace Contract Provider",
      version: "1.0.0",
      kind: "company-careers",
      supportLevel: "discovered",
      capabilities: ["discover-opportunities", "health-check"],
      baseUrls: ["https://careers.example.com/api"]
    });
    expect(descriptor.capabilities).toEqual(["discover-opportunities", "health-check"]);
  });
});
