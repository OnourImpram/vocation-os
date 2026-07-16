import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthorityOperation, VocationRequestOptions } from "@vocation-os/sdk";
import {
  createCareerAssuranceCase,
  evaluateCareerAssuranceCase,
  renderCareerAssuranceCaseJson,
  renderCareerAssuranceCaseMarkdown,
  toAssuranceDocumentAstInput,
  type AssuranceCurrentState,
  type CareerAssuranceCase,
  type CareerAssuranceCaseDraft
} from "../assurance/index.js";
import {
  AGENT_INTEGRATION_MANIFESTS,
  evaluateAgentIntegration,
  type AgentIntegrationProbe
} from "../agents/integration-manifests.js";
import {
  createCredentialClaimMapping,
  type CredentialClaimMappingDraft,
  type CredentialInputFormat,
  type CredentialPassportEntry
} from "../credentials/index.js";
import { DISCOVERY_PROVIDER_SUPPORT_REPORT } from "../discovery/provider-support.js";
import { sha256 } from "../hash.js";
import { MODEL_PROVIDER_MANIFESTS } from "../models/model-gateway.js";
import { PACKAGE_ROOT } from "../paths.js";
import { validateTaxonomySnapshot, type TaxonomySnapshot } from "../taxonomy/index.js";

export interface ProductCommandAuthority {
  request(
    operation: AuthorityOperation,
    payload?: unknown,
    options?: VocationRequestOptions
  ): Promise<unknown>;
}

interface VersionedValue<T> {
  recordId: string;
  version: number;
  value: T;
}

interface CompanyPortalCatalog {
  catalogVersion: string;
  generatedAt: string;
  organizations: unknown[];
  sourcePacks: Array<{ sourcePackId: string }>;
}

interface InstallerManifest {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

interface InstallerRuntime {
  verifyInstalledBundle(input: { targetDirectory: string; manifest: unknown }): Promise<unknown>;
  installVerifiedBundle(input: { bundleRoot: string; targetDirectory: string; manifest: unknown }): Promise<unknown>;
  updateVerifiedBundle(input: {
    bundleRoot: string;
    targetDirectory: string;
    currentManifest: unknown;
    nextManifest: unknown;
  }): Promise<unknown>;
  uninstallVerifiedBundle(input: { targetDirectory: string; manifest: unknown }): Promise<unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function versionedValue<T>(value: unknown, label: string): VersionedValue<T> {
  const envelope = record(value, label);
  if (typeof envelope["recordId"] !== "string" || !Number.isSafeInteger(envelope["version"])) {
    throw new Error(`${label} has an invalid versioned envelope`);
  }
  return envelope as unknown as VersionedValue<T>;
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === null) throw new Error(`${name} is required`);
  return value;
}

function readJson<T>(filePath: string, label: string): T {
  const absolute = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} could not be read as JSON`, { cause: error });
  }
  return parsed as T;
}

function writeText(filePath: string, content: string): string {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, { encoding: "utf8", flag: "wx" });
  return absolute;
}

function booleanFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function listedCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items.length : 0;
}

function credentialFormat(filePath: string, explicit: string | null): CredentialInputFormat {
  const candidate = explicit ?? path.extname(filePath).toLowerCase().replace(/^\./u, "");
  if (candidate === "png") return "baked-png";
  if (candidate === "svg") return "baked-svg";
  if (candidate === "jwt" || candidate === "jws") return "compact-jws";
  if (candidate === "jsonld" || candidate === "json-ld") return "json-ld";
  if (candidate === "json") return "json";
  throw new Error("Credential format must be json, json-ld, compact-jws, baked-png, or baked-svg");
}

function executableOnPath(candidates: readonly string[]): string | null {
  const searchDirectories = (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const windowsExtensions = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  for (const candidate of candidates) {
    const hasExtension = path.extname(candidate).length > 0;
    const extensions = process.platform === "win32" && !hasExtension ? windowsExtensions : [""];
    const roots = path.isAbsolute(candidate) || candidate.includes(path.sep) ? [""] : searchDirectories;
    for (const root of roots) {
      for (const extension of extensions) {
        const executablePath = root.length === 0
          ? `${candidate}${extension}`
          : path.join(root, `${candidate}${extension}`);
        try {
          accessSync(executablePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
          if (statSync(executablePath).isFile()) return candidate;
        } catch {
          // PATH entries are untrusted environment input. Unreadable candidates are treated as absent.
        }
      }
    }
  }
  return null;
}

export async function discoveryStatus(authority: ProductCommandAuthority): Promise<unknown> {
  const catalog = readJson<CompanyPortalCatalog>(
    path.join(PACKAGE_ROOT, "catalog", "v1", "company-portals.json"),
    "Company portal catalog"
  );
  const [observations, truth, liveness, dedupe] = await Promise.all([
    authority.request("source-observation-list", {}),
    authority.request("opportunity-truth-list", {}),
    authority.request("liveness-assessment-list", {}),
    authority.request("dedupe-result-list", {})
  ]);
  return {
    providers: DISCOVERY_PROVIDER_SUPPORT_REPORT,
    catalog: {
      catalogVersion: catalog.catalogVersion,
      generatedAt: catalog.generatedAt,
      verifiedOrganizationCount: catalog.organizations.length,
      sourcePackCount: catalog.sourcePacks.length
    },
    runtime: {
      observationCount: listedCount(observations),
      truthRecordCount: listedCount(truth),
      livenessAssessmentCount: listedCount(liveness),
      dedupeResultCount: listedCount(dedupe)
    },
    networkExecution: "requires-explicit-governed-network-grant"
  };
}

function stringHeaders(value: unknown): Readonly<Record<string, string>> {
  const candidate = record(value, "Discovery request headers");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(candidate)) {
    if (typeof headerValue !== "string") throw new Error(`Discovery header must be a string: ${name}`);
    headers[name] = headerValue;
  }
  return headers;
}

export async function discoveryCommand(
  authority: ProductCommandAuthority,
  args: readonly string[]
): Promise<unknown> {
  const subcommand = args[0] ?? "status";
  if (subcommand === "status") return discoveryStatus(authority);
  if (subcommand === "grant-register") {
    const envelope = readJson<unknown>(requiredOption(args, "--file"), "Signed network access grant");
    return authority.request(
      "network-grant-register",
      { envelope, scopeUrl: option(args, "--scope-url") },
      { requestId: requiredOption(args, "--request-id") }
    );
  }
  if (subcommand === "grant-list") {
    const limit = Number(option(args, "--limit") ?? "50");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("--limit must be an integer between 1 and 100");
    }
    return authority.request("network-grant-list", {
      cursor: option(args, "--cursor"),
      limit
    });
  }
  if (subcommand === "run") {
    const headersFile = option(args, "--headers");
    const headers = headersFile
      ? stringHeaders(readJson<unknown>(headersFile, "Discovery request headers"))
      : {};
    return authority.request(
      "discovery-run",
      {
        providerId: requiredOption(args, "--provider"),
        grantId: requiredOption(args, "--grant"),
        sourceKey: requiredOption(args, "--source-key"),
        url: requiredOption(args, "--url"),
        companyHint: option(args, "--company"),
        headers,
        operatorScopedTarget: booleanFlag(args, "--operator-scoped")
      },
      { requestId: requiredOption(args, "--request-id"), timeoutMs: 60_000 }
    );
  }
  throw new Error(`Unknown discovery command: ${subcommand}`);
}

export async function taxonomyCommand(
  authority: ProductCommandAuthority,
  args: readonly string[]
): Promise<unknown> {
  const subcommand = args[0] ?? "status";
  if (subcommand === "status") {
    const [snapshots, mappings] = await Promise.all([
      authority.request("taxonomy-snapshot-list", {}),
      authority.request("taxonomy-mapping-list", {})
    ]);
    return { snapshots, mappings };
  }
  if (subcommand === "sync") {
    const filePath = path.resolve(requiredOption(args, "--file"));
    const snapshot = readJson<TaxonomySnapshot>(filePath, "Taxonomy snapshot");
    const validation = validateTaxonomySnapshot(snapshot);
    if (!validation.valid) throw new Error(`Taxonomy snapshot is invalid: ${validation.errors.join(", ")}`);
    const manifest = await authority.request("artifact-import", { sourcePath: filePath });
    const expectedVersion = Number(option(args, "--expected-version") ?? "0");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("--expected-version must be a non-negative integer");
    }
    return authority.request(
      "taxonomy-snapshot-import-artifact",
      { manifest, expectedVersion },
      { requestId: requiredOption(args, "--request-id") }
    );
  }
  if (subcommand === "map-role" || subcommand === "map-skills") {
    const snapshotId = requiredOption(args, "--snapshot");
    const queries = subcommand === "map-role"
      ? [requiredOption(args, "--query")]
      : requiredOption(args, "--query").split(",").map((value) => value.trim()).filter(Boolean);
    if (queries.length === 0) throw new Error("Taxonomy mapping requires at least one query");
    const limit = Number(option(args, "--limit") ?? "5");
    const minimumScore = Number(option(args, "--minimum-score") ?? "0.25");
    return authority.request("taxonomy-query", { snapshotId, queries, limit, minimumScore });
  }
  throw new Error(`Unknown taxonomy command: ${subcommand}`);
}

async function assuranceCaseFromArgs(
  authority: ProductCommandAuthority,
  args: readonly string[]
): Promise<CareerAssuranceCase> {
  const file = option(args, "--file");
  if (file) return readJson<CareerAssuranceCase>(file, "Career Assurance Case");
  const caseId = requiredOption(args, "--id");
  const stored = await authority.request("assurance-case-get", { recordId: caseId });
  if (stored === null) throw new Error(`Career Assurance Case was not found: ${caseId}`);
  return versionedValue<CareerAssuranceCase>(stored, "Career Assurance Case").value;
}

export async function assuranceCommand(
  authority: ProductCommandAuthority,
  args: readonly string[],
  now = new Date()
): Promise<unknown> {
  const subcommand = args[0] ?? "inspect";
  if (subcommand === "build") {
    const draft = readJson<CareerAssuranceCaseDraft>(requiredOption(args, "--file"), "Assurance draft");
    const assuranceCase = createCareerAssuranceCase(draft, now);
    const existing = await authority.request("assurance-case-get", { recordId: assuranceCase.caseId });
    const expectedVersion = existing === null ? 0 : versionedValue<CareerAssuranceCase>(existing, "Career Assurance Case").version;
    return authority.request(
      "assurance-case-record",
      { value: assuranceCase, expectedVersion },
      { requestId: requiredOption(args, "--request-id") }
    );
  }
  if (subcommand === "inspect") {
    return assuranceCaseFromArgs(authority, args);
  }
  if (subcommand === "validate" || subcommand === "report") {
    const assuranceCase = await assuranceCaseFromArgs(authority, args);
    const currentStateFile = option(args, "--current-state");
    const currentState = currentStateFile
      ? readJson<AssuranceCurrentState>(currentStateFile, "Assurance current state")
      : undefined;
    const evaluation = evaluateCareerAssuranceCase(assuranceCase, {
      now,
      ...(currentState ? { currentState } : {}),
      requireCertification: !booleanFlag(args, "--allow-uncertified")
    });
    if (subcommand === "validate") return evaluation;
    const format = option(args, "--format") ?? "markdown";
    const content = format === "json"
      ? renderCareerAssuranceCaseJson(assuranceCase, evaluation)
      : format === "markdown"
        ? renderCareerAssuranceCaseMarkdown(assuranceCase, evaluation)
        : format === "ast"
          ? `${JSON.stringify(toAssuranceDocumentAstInput(assuranceCase, evaluation), null, 2)}\n`
          : (() => { throw new Error("Assurance report format must be json, markdown, or ast"); })();
    const output = option(args, "--output");
    return output ? { outputPath: writeText(output, content), evaluation } : { content, evaluation };
  }
  throw new Error(`Unknown assurance command: ${subcommand}`);
}

export async function credentialCommand(
  authority: ProductCommandAuthority,
  args: readonly string[],
  now = new Date()
): Promise<unknown> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") return authority.request("credential-passport-list", {});
  if (subcommand === "import") {
    const filePath = path.resolve(requiredOption(args, "--file"));
    const format = credentialFormat(filePath, option(args, "--format"));
    const manifest = await authority.request("artifact-import", { sourcePath: filePath });
    const expectedSubjectId = option(args, "--subject");
    const expectedVersion = Number(option(args, "--expected-version") ?? "0");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("--expected-version must be a non-negative integer");
    }
    return authority.request(
      "credential-import-artifact",
      {
        manifest,
        format,
        expectedSubjectId,
        importedAt: now.toISOString(),
        expectedVersion
      },
      { requestId: requiredOption(args, "--request-id") }
    );
  }
  if (subcommand === "verify") {
    const passportId = requiredOption(args, "--id");
    const stored = await authority.request("credential-passport-get", { recordId: passportId });
    if (stored === null) throw new Error(`Credential passport was not found: ${passportId}`);
    const entry = versionedValue<CredentialPassportEntry>(stored, "Credential passport").value;
    return {
      passportEntryId: entry.passportEntryId,
      canonicalCredentialHash: entry.canonicalCredentialHash,
      verification: entry.verification,
      verified: entry.verification.overall === "verified",
      currentReverification: "re-import-original-with-current-governed-verifiers"
    };
  }
  if (subcommand === "map") {
    const passportId = requiredOption(args, "--id");
    const stored = await authority.request("credential-passport-get", { recordId: passportId });
    if (stored === null) throw new Error(`Credential passport was not found: ${passportId}`);
    const entry = versionedValue<CredentialPassportEntry>(stored, "Credential passport").value;
    const draft: CredentialClaimMappingDraft = {
      mappingId: requiredOption(args, "--mapping-id"),
      claimType: requiredOption(args, "--claim-type") as CredentialClaimMappingDraft["claimType"],
      claimText: requiredOption(args, "--claim"),
      requestedPublic: booleanFlag(args, "--public"),
      requestedAutoApply: booleanFlag(args, "--auto-apply")
    };
    const mapping = createCredentialClaimMapping(entry, draft);
    return authority.request(
      "credential-mapping-record",
      { value: mapping, expectedVersion: 0 },
      { requestId: requiredOption(args, "--request-id") }
    );
  }
  if (subcommand === "export") {
    const passportId = requiredOption(args, "--id");
    const outputPath = path.resolve(requiredOption(args, "--output"));
    const requestId = requiredOption(args, "--request-id");
    const generated = record(await authority.request(
      "credential-export-artifact",
      { passportId, exportedAt: now.toISOString() },
      { requestId }
    ), "Credential export artifact");
    const manifest = generated["artifact"];
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error("Credential export did not return an artifact manifest");
    }
    const writeRequestId = `REQ-${sha256(`${requestId}:artifact-export:${outputPath}`)
      .slice("sha256:".length, "sha256:".length + 48)}`;
    const exported = await authority.request(
      "artifact-export",
      { manifest, outputPath },
      { requestId: writeRequestId }
    );
    return {
      passportId,
      packageHash: generated["packageHash"],
      artifact: manifest,
      exported
    };
  }
  throw new Error(`Unknown credential command: ${subcommand}`);
}

export function agentIntegrationStatus(now = new Date()): unknown {
  return AGENT_INTEGRATION_MANIFESTS.map((manifest) => {
    const detectedBinary = executableOnPath(manifest.binaryCandidates);
    const probe: AgentIntegrationProbe = {
      agentId: manifest.agentId,
      detectedBinary,
      invocationSucceeded: false,
      conformancePassed: false,
      daemonAuthorityConfirmed: false,
      checkedAt: now.toISOString(),
      diagnostics: detectedBinary === null ? [] : ["discovery-only-no-invocation-performed"]
    };
    return {
      manifest,
      status: evaluateAgentIntegration(probe)
    };
  });
}

function integrationManifest(agentId: string): (typeof AGENT_INTEGRATION_MANIFESTS)[number] {
  const manifest = AGENT_INTEGRATION_MANIFESTS.find((candidate) => candidate.agentId === agentId);
  if (!manifest) throw new Error(`Unknown agent integration: ${agentId}`);
  return manifest;
}

function shippedSkillManifest(): InstallerManifest {
  const source = readJson<InstallerManifest>(
    path.join(PACKAGE_ROOT, "packages", "agent-skill", "checksums.json"),
    "Agent skill checksum manifest"
  );
  const skillFiles = source.files
    .filter((entry) => entry.path.startsWith("skill/vocation-os/"))
    .map((entry) => ({ ...entry, path: entry.path.slice("skill/vocation-os/".length) }));
  if (skillFiles.length === 0) throw new Error("Packaged agent skill checksum manifest is empty");
  return { schemaVersion: 1, algorithm: "sha256", files: skillFiles };
}

function explicitAbsoluteTarget(args: readonly string[]): string {
  const target = requiredOption(args, "--target");
  if (!path.isAbsolute(target)) throw new Error("--target must be an explicit absolute path");
  return path.normalize(target);
}

async function installerRuntime(): Promise<InstallerRuntime> {
  const modulePath = path.join(PACKAGE_ROOT, "packages", "installer", "dist", "index.js");
  try {
    return await import(pathToFileURL(modulePath).href) as InstallerRuntime;
  } catch (error) {
    throw new Error("Packaged installer runtime is unavailable. Run npm run build first", { cause: error });
  }
}

function installerError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "installer-error";
    return { code, message: error.message };
  }
  return { code: "installer-error", message: String(error) };
}

export async function agentIntegrationCommand(args: readonly string[]): Promise<unknown> {
  const subcommand = args[0] ?? "status";
  if (subcommand === "status") return agentIntegrationStatus();
  if (subcommand === "help") {
    return {
      usage: [
        "vocation agents status",
        "vocation agents manifest --agent <id>",
        "vocation agents doctor --agent <id> --target <absolute-skill-directory>",
        "vocation agents install --agent <id> --target <absolute-skill-directory>",
        "vocation agents update --agent <id> --target <absolute-skill-directory> --current-manifest <file>",
        "vocation agents uninstall --agent <id> --target <absolute-skill-directory> [--current-manifest <file>]"
      ],
      policy: "explicit-target-checksum-gated-copy-only"
    };
  }
  const agentId = requiredOption(args, "--agent");
  const agent = integrationManifest(agentId);
  const nextManifest = shippedSkillManifest();
  if (subcommand === "manifest") return { agent, manifest: nextManifest };
  const targetDirectory = explicitAbsoluteTarget(args);
  const installer = await installerRuntime();
  if (subcommand === "doctor") {
    try {
      const verification = await installer.verifyInstalledBundle({ targetDirectory, manifest: nextManifest });
      return { agentId, targetDirectory, status: "verified-current", verification };
    } catch (error) {
      return { agentId, targetDirectory, status: "missing-or-modified", error: installerError(error) };
    }
  }
  const bundleRoot = path.join(PACKAGE_ROOT, "packages", "agent-skill", "skill", "vocation-os");
  if (subcommand === "install") {
    return {
      agentId,
      operation: "installed",
      receipt: await installer.installVerifiedBundle({ bundleRoot, targetDirectory, manifest: nextManifest })
    };
  }
  const currentManifestPath = option(args, "--current-manifest");
  const currentManifest = currentManifestPath === null
    ? nextManifest
    : readJson<unknown>(currentManifestPath, "Current installed skill manifest");
  if (subcommand === "update") {
    if (currentManifestPath === null) throw new Error("agents update requires --current-manifest for the installed version");
    return {
      agentId,
      operation: "updated",
      receipt: await installer.updateVerifiedBundle({
        bundleRoot,
        targetDirectory,
        currentManifest,
        nextManifest
      })
    };
  }
  if (subcommand === "uninstall") {
    return {
      agentId,
      operation: "uninstalled",
      receipt: await installer.uninstallVerifiedBundle({ targetDirectory, manifest: currentManifest })
    };
  }
  throw new Error(`Unknown agents command: ${subcommand}`);
}

export function modelProviderStatus(): unknown {
  return MODEL_PROVIDER_MANIFESTS.map((manifest) => ({
    ...manifest,
    credentialConfigured: "not-inspected",
    endpointHealth: "not-probed",
    supportTruth: manifest.locality === "local" ? "configured-local-capability" : "egress-approval-required"
  }));
}
