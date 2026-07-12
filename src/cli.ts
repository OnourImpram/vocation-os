#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { VocationClient, type VocationRequestOptions } from "@vocation-os/sdk";
import { WORKER_ROLES } from "./agent-controller.js";
import { defaultLedgerPath } from "./action-ledger.js";
import { createApprovalReference, type TrustedApprover } from "./approval.js";
import { decideAutoApply, defaultAutoApplyConfig } from "./auto-apply.js";
import { OfflineTemplateClient, generateAdvisoryNote } from "./advisor.js";
import { createVocationBenchManifest } from "./benchmark/vocation-bench.js";
import { createCareerTwin } from "./career-twin.js";
import { validateApplicationPacket, validateClaimGraph } from "./claim-graph.js";
import { buildCoachingPlan, PHT_SKILLS } from "./coach.js";
import { runEvaluator } from "./evaluator.js";
import { computeActionIntentHash } from "./hash.js";
import { runDeepFit, runMode } from "./modes.js";
import { createOpportunityRecord, evaluateOpportunityIntake } from "./opportunity.js";
import {
  EXAMPLES_DIR,
  PACKAGE_ROOT,
  defaultDaemonEndpoint,
  defaultDaemonLockPath,
  defaultDatabasePath,
  defaultRuntimeRoot
} from "./paths.js";
import { evaluateCareerPortfolio, PORTFOLIO_OBJECTIVES, type PortfolioWeights } from "./portfolio.js";
import { demoDimensions, DIMENSION_IDS, scoreOpportunity } from "./rubric.js";
import { SCHEMA_NAMES, assertSchema, validateAllSchemaFiles, validateAgainstSchema } from "./schema.js";
import { defaultStateDir, readState, validateStateDirectory, writeState } from "./state.js";
import { EncryptedEventStore } from "./storage/encrypted-event-store.js";
import { createEncryptedBackup, restoreEncryptedBackup } from "./storage/encrypted-backup.js";
import { acquireSingleInstanceLock } from "./runtime/single-instance.js";
import { callAuthority, daemonEndpointReachable } from "./ipc/client.js";
import {
  CREDENTIAL_ACCOUNTS,
  credentialServiceName,
  EncryptedFileCredentialStore,
  OsCredentialStore,
  type CredentialStore
} from "./security/credential-store.js";
import type { AuthorityOperation } from "./ipc/protocol.js";
import { readMaskedSecret } from "./security/secret-input.js";
import { verifyCheckpointChain, verifyCheckpointRecords } from "./security/audit-checkpoint.js";
import { recoverInterruptedRestore } from "./storage/encrypted-backup.js";
import { THEORY_NAMES } from "./theory.js";
import { CLI_COMMANDS, HIGH_STAKES_FLAGS, MODE_NAMES, PRODUCT_NAME, TAGLINE, type ApplicationPacket, type ClaimGraph, type HighStakesFlags } from "./types.js";
import { runProductInitialization, type ProductInitMode } from "./product-init.js";
import { writeDocumentBundle } from "./documents/document-renderer.js";
import type { DocumentAstV2 } from "./documents/document-ast-v2.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function cliCredentialStore(): Promise<CredentialStore> {
  if (process.argv.includes("--headless")) {
    const passphrase = await readMaskedSecret("Headless master passphrase: ");
    return EncryptedFileCredentialStore.open(
      path.join(defaultRuntimeRoot(), "headless-credentials.vault"),
      passphrase
    );
  }
  return OsCredentialStore.create(credentialServiceName(defaultRuntimeRoot()));
}

async function openDaemonClient(): Promise<{ client: VocationClient; close(): Promise<void> }> {
  const credentials = await cliCredentialStore();
  const ipcSecret = await credentials.get(CREDENTIAL_ACCOUNTS.ipcSecret);
  if (!ipcSecret) {
    await credentials.close?.();
    if (!process.argv.includes("--headless") && existsSync(path.join(defaultRuntimeRoot(), "headless-credentials.vault"))) {
      throw new Error("The running daemon uses headless credentials. Re-run this command with --headless");
    }
    throw new Error("Daemon credentials are not initialized. Start vocationd first");
  }
  return {
    client: new VocationClient({
      execute: (request) => callAuthority({
        endpoint: defaultDaemonEndpoint(),
        ipcSecret,
        operation: request.operation,
        payload: request.payload,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
      })
    }),
    close: async () => credentials.close?.()
  };
}

async function callDaemon(
  operation: AuthorityOperation,
  payload: unknown = {},
  options: VocationRequestOptions = {}
): Promise<unknown> {
  const daemon = await openDaemonClient();
  try {
    return await daemon.client.request(operation, payload, options);
  } finally {
    await daemon.close();
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function ensureDaemonStarted(): Promise<void> {
  const endpoint = defaultDaemonEndpoint();
  if (await daemonEndpointReachable(endpoint, 500)) return;
  if (process.argv.includes("--headless")) {
    throw new Error("Headless initialization requires vocationd start --headless in a separate terminal");
  }
  const daemonPath = path.join(PACKAGE_ROOT, "dist", "vocationd.js");
  if (!existsSync(daemonPath)) throw new Error("Compiled vocationd binary is missing. Run npm run build first");
  const child = spawn(process.execPath, [daemonPath, "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env
  });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await daemonEndpointReachable(endpoint, 250)) return;
    await wait(100);
  }
  throw new Error("vocationd did not become ready within 10 seconds");
}

async function withExclusiveStore<T>(operation: (store: EncryptedEventStore) => Promise<T>): Promise<T> {
  const lock = await acquireSingleInstanceLock({
    lockPath: defaultDaemonLockPath(),
    endpoint: defaultDaemonEndpoint(),
    endpointReachable: daemonEndpointReachable
  });
  let store: EncryptedEventStore | null = null;
  let credentials: CredentialStore | null = null;
  try {
    credentials = await cliCredentialStore();
    const databasePassphrase = await credentials.get(CREDENTIAL_ACCOUNTS.databasePassphrase);
    if (!databasePassphrase) throw new Error("Database credential is not initialized. Start vocationd first");
    await recoverInterruptedRestore({
      journalPath: `${defaultDatabasePath()}.restore-journal.json`,
      databasePath: defaultDatabasePath(),
      storePassphrase: databasePassphrase
    });
    store = await EncryptedEventStore.open(defaultDatabasePath(), databasePassphrase);
    await verifyCheckpointChain(store, credentials);
    return await operation(store);
  } finally {
    if (store) await store.close();
    await credentials?.close?.();
    lock.release();
  }
}

function readExample<T>(fileName: string): T {
  const filePath = path.join(EXAMPLES_DIR, "demo-profile", fileName);
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

const demoApproverKeyPair = generateKeyPairSync("ed25519");
const demoTrustedApprover: TrustedApprover = {
  approvedBy: "demo-operator",
  keyId: "KEY-DEMO-APPROVER-001",
  publicKeyPem: demoApproverKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
};

function demoApprovalReference(packet: ApplicationPacket, now: Date) {
  return createApprovalReference({
    approvalId: "APR-DEMO-001",
    operation: "auto-apply",
    approvedBy: demoTrustedApprover.approvedBy,
    keyId: demoTrustedApprover.keyId,
    approvedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    approvalTextHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    opportunityId: packet.opportunityId,
    packetHash: packet.packetHash,
    adapterId: "local-fixture",
    actionIntentHash: computeActionIntentHash({
      operation: "auto-apply",
      opportunityId: packet.opportunityId,
      packetHash: packet.packetHash,
      adapterId: "local-fixture",
      reversibilityTag: "R3"
    }),
    allowedFields: ["application-packet"]
  }, demoApproverKeyPair.privateKey);
}

function noRiskSignals() {
  return {
    captchaPresent: false,
    antiBotDetected: false,
    paymentRequired: false,
    identityCheckRequired: false,
    tosUnclear: false,
    unsupportedLicenseClaim: false,
    credentialFabricationRequested: false
  };
}

function noHighStakesFlags(): HighStakesFlags {
  return Object.fromEntries(HIGH_STAKES_FLAGS.map((flag) => [flag, false])) as HighStakesFlags;
}

function metrics(): Record<string, number> {
  return {
    modes: MODE_NAMES.length,
    theories: THEORY_NAMES.length,
    rubricDimensions: DIMENSION_IDS.length,
    schemas: SCHEMA_NAMES.length,
    cliCommands: CLI_COMMANDS.length,
    evaluatorTests: runEvaluator().total
  };
}

function help(): void {
  console.log(`${PRODUCT_NAME}`);
  console.log(TAGLINE);
  console.log("");
  console.log("Commands:");
  for (const command of CLI_COMMANDS) {
    console.log(`  vocation ${command}`);
  }
  console.log("");
  console.log("Consequential automation is conditional on evidence, reversibility, stakes, and authorization.");
}

function doctor(): void {
  const schemaCheck = validateAllSchemaFiles();
  printJson({
    product: PRODUCT_NAME,
    node: process.version,
    schemaValid: schemaCheck.valid,
    schemaErrors: schemaCheck.errors,
    metrics: metrics(),
    stateDir: defaultStateDir()
  });
  if (!schemaCheck.valid) {
    process.exitCode = 1;
  }
}

function validateSchemas(): void {
  const schemaCheck = validateAllSchemaFiles();
  const graph = readExample<ClaimGraph>("claim-graph.json");
  const validPacket = readExample<ApplicationPacket>("application-packet.valid.json");
  const blockedPacket = readExample<ApplicationPacket>("application-packet.blocked.json");
  const results = {
    schemas: schemaCheck,
    graph: validateAgainstSchema("claim-graph", graph),
    validPacket: validateAgainstSchema("application-packet", validPacket),
    blockedPacket: validateAgainstSchema("application-packet", blockedPacket)
  };
  printJson(results);
  if (!schemaCheck.valid || !results.graph.valid || !results.validPacket.valid || !results.blockedPacket.valid) {
    process.exitCode = 1;
  }
}

function selfcheck(): void {
  const baseDir = defaultStateDir();
  const probeKey = `probe:${process.pid}:${Date.now()}`;
  const modeOutput = runMode("/auto-apply-config");
  writeState(baseDir, probeKey, { ok: true, product: PRODUCT_NAME });
  writeState(baseDir, "mode-output:selfcheck", modeOutput);
  const readBack = readState<{ ok: boolean }>(baseDir, probeKey);
  printJson({
    ok: readBack.ok === true,
    stateDir: baseDir,
    unsafeKeyEncoded: true,
    modeOutput
  });
  if (readBack.ok !== true) {
    process.exitCode = 1;
  }
}

function evaluate(): void {
  const result = runEvaluator();
  printJson(result);
  if (result.verdict !== "PASS") {
    process.exitCode = 1;
  }
}

function demoScore(): void {
  printJson(scoreOpportunity({ dimensions: demoDimensions() }));
}

function demoSteelman(): void {
  printJson({
    routes: [
      "optimist",
      "conservative",
      "optionality_preserving",
      "identity_congruent",
      "market_leverage",
      "health_boundary"
    ]
  });
}

function demoAutoApplyDecision(): void {
  const graph = readExample<ClaimGraph>("claim-graph.json");
  const packet = readExample<ApplicationPacket>("application-packet.blocked.json");
  const config = {
    ...defaultAutoApplyConfig(),
    enabled: true,
    mode: "auto" as const
  };
  const now = new Date();
  const decision = decideAutoApply({
    config,
    packet,
    claimGraph: graph,
    reversibilityTag: "R3",
    adapterId: "local-fixture",
    approvalReference: demoApprovalReference(packet, now),
    trustedApprovers: [demoTrustedApprover],
    riskSignals: noRiskSignals(),
    highStakesFlags: noHighStakesFlags(),
    documentRoot: PACKAGE_ROOT,
    ledgerPath: defaultLedgerPath(),
    now
  });
  printJson(decision);
}

function demoAutoApplyAllowed(): void {
  const graph = readExample<ClaimGraph>("claim-graph.json");
  const packet = readExample<ApplicationPacket>("application-packet.valid.json");
  const config = {
    ...defaultAutoApplyConfig(),
    enabled: true,
    mode: "auto" as const
  };
  const now = new Date();
  const decision = decideAutoApply({
    config,
    packet,
    claimGraph: graph,
    reversibilityTag: "R3",
    adapterId: "local-fixture",
    approvalReference: demoApprovalReference(packet, now),
    trustedApprovers: [demoTrustedApprover],
    riskSignals: noRiskSignals(),
    highStakesFlags: noHighStakesFlags(),
    documentRoot: PACKAGE_ROOT,
    ledgerPath: defaultLedgerPath(),
    now
  });
  printJson(decision);
}

function demoCareerTwin(): void {
  printJson(createCareerTwin("synthetic", [], [
    { goalId: "GOAL-DEMO-001", label: "Preserve optionality while testing a new role family", horizon: "one-year", priority: 80, status: "active" }
  ]));
}

function demoPortfolio(): void {
  const scores = (value: number) => Object.fromEntries(PORTFOLIO_OBJECTIVES.map((objective) => [objective, value])) as Record<(typeof PORTFOLIO_OBJECTIVES)[number], number>;
  const weights = Object.fromEntries(PORTFOLIO_OBJECTIVES.map((objective) => [objective, 1])) as PortfolioWeights;
  printJson(evaluateCareerPortfolio([
    { optionId: "ROUTE-REMOTE-AI", label: "Remote AI role", routeType: "job", scores: scores(78), uncertaintyBand: [68, 84], failedGates: [] },
    { optionId: "ROUTE-FELLOWSHIP", label: "Research fellowship", routeType: "fellowship", scores: { ...scores(70), prestige: 90, "immigration-evidence": 88 }, uncertaintyBand: [60, 82], failedGates: [] },
    { optionId: "ROUTE-BLOCKED", label: "License gated role", routeType: "job", scores: scores(92), uncertaintyBand: [75, 95], failedGates: ["license-not-verified"] }
  ], weights));
}

function demoOpportunityIntake(): void {
  const opportunity = createOpportunityRecord({
    source: "manual",
    sourceId: "DEMO-REMOTE-001",
    sourceUrl: "https://example.test/jobs/demo-remote-001",
    applyUrl: "https://example.test/jobs/demo-remote-001/apply",
    company: "Synthetic Research Lab",
    roleTitle: "Responsible AI Researcher",
    locationText: "Remote worldwide",
    remotePolicy: "remote",
    applicantLocationRequirements: ["worldwide"],
    descriptionText: "A synthetic opportunity used to test evidence grounded opportunity intake and remote eligibility gates.",
    postedAt: new Date().toISOString(),
    extractionConfidence: "high",
    sourcePayload: { fixture: true }
  });
  printJson({ opportunity, decision: evaluateOpportunityIntake(opportunity, {
    requiresRemote: true,
    requireExplicitApplicantLocation: true,
    candidateRegions: ["worldwide"],
    maxAgeDays: 14,
    minimumDescriptionCharacters: 60,
    existingFingerprints: [],
    evaluatedAt: new Date().toISOString()
  }) });
}

function demoSkillCoach(): void {
  printJson(buildCoachingPlan({
    ratings: PHT_SKILLS.map((skill, index) => ({ skill, rating: Math.min(4, index) as 0 | 1 | 2 | 3 | 4 }))
  }));
}

async function demoAdvisory(): Promise<void> {
  const claimGraph = readExample<ClaimGraph>("claim-graph.json");
  printJson(await generateAdvisoryNote(new OfflineTemplateClient(), {
    mode: "/deep-fit",
    opportunityId: "OPP-DEMO-001",
    opportunitySummary: "Synthetic remote research role requiring evidence grounded evaluation.",
    claimGraph,
    reversibilityTag: "R0",
    dataClassification: "public",
    remoteEgressApproved: false
  }));
}

function benchmark(): void {
  printJson(createVocationBenchManifest());
}

async function storeVerify(): Promise<void> {
  if (!existsSync(defaultDatabasePath())) throw new Error("Canonical encrypted store does not exist");
  const report = await withExclusiveStore(async (store) => ({
    ...(await store.verifyIntegrity()),
    databaseId: await store.databaseId(),
    migrations: store.migrations()
  }));
  assertSchema("store-verification-report", report);
  printJson(report);
}

async function daemonStatus(): Promise<void> {
  printJson(await callDaemon("health"));
}

async function daemonStop(): Promise<void> {
  const response = await callDaemon("daemon-stop");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await daemonEndpointReachable(defaultDaemonEndpoint(), 100)) && !existsSync(defaultDaemonLockPath())) {
      printJson(response);
      return;
    }
    await wait(50);
  }
  throw new Error("vocationd accepted shutdown but did not release its endpoint and lock within 5 seconds");
}

async function autoApplyStatus(): Promise<void> {
  printJson(await callDaemon("auto-apply-status"));
}

async function autoApplyKill(): Promise<void> {
  printJson(await callDaemon("auto-apply-kill", { reason: "operator kill command" }));
}

async function autoApplyRearm(): Promise<void> {
  printJson(await callDaemon("auto-apply-rearm"));
}

async function autoApplyEnable(): Promise<void> {
  const mode = process.argv[3] === "auto" ? "auto" : "draft-only";
  printJson(await callDaemon("auto-apply-enable", { mode }));
}

async function autoApplyEvaluate(): Promise<void> {
  const filePath = process.argv[3];
  if (!filePath) throw new Error("auto-apply-evaluate requires a JSON input file");
  const value = JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as unknown;
  printJson(await callDaemon("auto-apply-evaluate", value));
}

function validateState(): void {
  const report = validateStateDirectory(defaultStateDir());
  printJson(report);
  if (!report.valid) {
    process.exitCode = 1;
  }
}

async function exportAudit(): Promise<void> {
  printJson(await callDaemon("audit-export"));
}

async function legacyImportPlan(): Promise<void> {
  printJson(await callDaemon("legacy-import-plan"));
}

async function legacyImportApply(): Promise<void> {
  const planHash = process.argv[3];
  if (!planHash) throw new Error("legacy-import-apply requires the approved plan hash");
  printJson(await callDaemon("legacy-import-apply", { planHash }));
}

async function checkpointCreate(): Promise<void> {
  printJson(await callDaemon("checkpoint-create"));
}

async function checkpointVerify(): Promise<void> {
  printJson(await callDaemon("checkpoint-verify"));
}

async function approverList(): Promise<void> {
  printJson(await callDaemon("approver-list"));
}

async function approverRegister(): Promise<void> {
  const filePath = process.argv[3];
  if (!filePath) throw new Error("approver-register requires a JSON file containing approvedBy, keyId, and publicKeyPem");
  const value = JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as unknown;
  printJson(await callDaemon("approver-register", value));
}

async function approverRevoke(): Promise<void> {
  const keyId = process.argv[3];
  if (!keyId) throw new Error("approver-revoke requires a key id");
  printJson(await callDaemon("approver-revoke", { keyId }));
}

async function collectorList(): Promise<void> {
  printJson(await callDaemon("collector-list"));
}

async function collectorRegister(): Promise<void> {
  const filePath = process.argv[3];
  if (!filePath) throw new Error("collector-register requires a trusted collector JSON file");
  const value = JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as unknown;
  assertSchema("trusted-collector", value);
  printJson(await callDaemon("collector-register", value));
}

async function collectorRevoke(): Promise<void> {
  const keyId = process.argv[3];
  if (!keyId) throw new Error("collector-revoke requires a key id");
  printJson(await callDaemon("collector-revoke", { keyId }));
}

function argumentAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

async function initProduct(): Promise<void> {
  const configArgument = argumentAfter("--config");
  let profileArgument = argumentAfter("--profile");
  const modes = [process.argv.includes("--demo"), profileArgument !== null, process.argv.includes("--resume"), configArgument !== null]
    .filter(Boolean).length;
  if (modes !== 1) throw new Error("init requires exactly one of --demo, --profile <path>, --resume, or --config <json>");
  let mode: ProductInitMode;
  if (configArgument) {
    const configPath = path.resolve(configArgument);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      version: 1;
      mode: ProductInitMode;
      profilePath: string | null;
    };
    assertSchema("product-init-config", config);
    mode = config.mode;
    profileArgument = config.profilePath
      ? path.resolve(path.dirname(configPath), config.profilePath)
      : null;
  } else {
    mode = process.argv.includes("--demo")
      ? "demo"
      : profileArgument !== null
        ? "profile"
        : "resume";
  }
  await ensureDaemonStarted();
  const daemon = await openDaemonClient();
  try {
    printJson(await runProductInitialization(daemon.client, {
      mode,
      ...(profileArgument ? { profilePath: path.resolve(profileArgument) } : {})
    }));
  } finally {
    await daemon.close();
  }
}

async function artifactImport(): Promise<void> {
  const filePath = process.argv[3];
  if (!filePath) throw new Error("artifact-import requires a local file path");
  printJson(await callDaemon("artifact-import", { sourcePath: path.resolve(filePath) }));
}

async function artifactList(): Promise<void> {
  printJson(await callDaemon("artifact-list"));
}

async function domainPut(): Promise<void> {
  const domain = process.argv[3];
  const filePath = process.argv[4];
  const version = Number(process.argv[5] ?? "0");
  if (!domain || !filePath) throw new Error("domain-put requires <domain> <json-file> [expected-version]");
  const value = JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as unknown;
  const claimGraphPath = argumentAfter("--claim-graph");
  const claimGraph = claimGraphPath
    ? JSON.parse(readFileSync(path.resolve(claimGraphPath), "utf8")) as unknown
    : undefined;
  printJson(await callDaemon("domain-put", {
    domain,
    expectedVersion: version,
    value,
    ...(claimGraph !== undefined ? { claimGraph } : {})
  }));
}

async function domainGet(): Promise<void> {
  const domain = process.argv[3];
  const recordId = process.argv[4];
  if (!domain || !recordId) throw new Error("domain-get requires <domain> <record-id>");
  printJson(await callDaemon("domain-get", { domain, recordId, includeArchived: process.argv.includes("--all") }));
}

async function domainList(): Promise<void> {
  const domain = process.argv[3];
  if (!domain) throw new Error("domain-list requires <domain>");
  printJson(await callDaemon("domain-list", { domain, includeArchived: process.argv.includes("--all") }));
}

async function domainArchive(): Promise<void> {
  const domain = process.argv[3];
  const recordId = process.argv[4];
  const version = Number(process.argv[5]);
  if (!domain || !recordId || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("domain-archive requires <domain> <record-id> <expected-version>");
  }
  printJson(await callDaemon("domain-archive", { domain, recordId, expectedVersion: version }));
}

async function onboardingStatus(): Promise<void> {
  printJson(await callDaemon("onboarding-status"));
}

async function profileImportPlan(): Promise<void> {
  const manifestPath = process.argv[3];
  const format = process.argv[4];
  if (!manifestPath || !format) throw new Error("profile-import-plan requires <manifest-json> <pdf|docx|markdown|text>");
  const manifest = JSON.parse(readFileSync(path.resolve(manifestPath), "utf8")) as unknown;
  printJson(await callDaemon("profile-import-plan", { manifest, format }));
}

async function profileImportApply(): Promise<void> {
  const planHash = process.argv[3];
  if (!planHash) throw new Error("profile-import-apply requires an approved plan hash");
  printJson(await callDaemon("profile-import-apply", { planHash }));
}

async function documentRender(): Promise<void> {
  const documentPath = process.argv[3];
  const graphPath = process.argv[4];
  const outputRoot = process.argv[5];
  if (!documentPath || !graphPath || !outputRoot) {
    throw new Error("document-render requires <document-v2-json> <claim-graph-json> <output-directory>");
  }
  const document = JSON.parse(readFileSync(path.resolve(documentPath), "utf8")) as DocumentAstV2;
  const graph = JSON.parse(readFileSync(path.resolve(graphPath), "utf8")) as ClaimGraph;
  printJson(await writeDocumentBundle(document, graph, path.resolve(outputRoot)));
}

async function trackerList(): Promise<void> {
  printJson(await callDaemon("tracker-list", { includeArchived: process.argv.includes("--all") }));
}

async function trackerGet(): Promise<void> {
  const attemptId = process.argv[3];
  if (!attemptId) throw new Error("tracker-get requires <attempt-id>");
  printJson(await callDaemon("tracker-get", { attemptId }));
}

async function trackerCreate(): Promise<void> {
  const inputPath = process.argv[3];
  if (!inputPath) throw new Error("tracker-create requires <input-json>");
  const input = JSON.parse(readFileSync(path.resolve(inputPath), "utf8")) as unknown;
  printJson(await callDaemon("tracker-create", { input }));
}

async function trackerApprove(): Promise<void> {
  const attemptId = process.argv[3];
  const version = Number(process.argv[4]);
  const approvalPath = process.argv[5];
  if (!attemptId || !Number.isSafeInteger(version) || version < 0 || !approvalPath) {
    throw new Error("tracker-approve requires <attempt-id> <expected-version> <approval-json>");
  }
  const approval = JSON.parse(readFileSync(path.resolve(approvalPath), "utf8")) as unknown;
  printJson(await callDaemon("tracker-approve", { attemptId, expectedVersion: version, approval }));
}

async function trackerSubmit(): Promise<void> {
  const attemptId = process.argv[3];
  const version = Number(process.argv[4]);
  if (!attemptId || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("tracker-submit requires <attempt-id> <expected-version>");
  }
  printJson(await callDaemon("tracker-submit", { attemptId, expectedVersion: version }));
}

async function trackerBlock(): Promise<void> {
  const attemptId = process.argv[3];
  const version = Number(process.argv[4]);
  const blocker = process.argv.slice(5).join(" ").trim();
  if (!attemptId || !Number.isSafeInteger(version) || version < 0 || !blocker) {
    throw new Error("tracker-block requires <attempt-id> <expected-version> <reason>");
  }
  printJson(await callDaemon("tracker-block", { attemptId, expectedVersion: version, blocker }));
}

async function trackerConfirm(): Promise<void> {
  const attemptId = process.argv[3];
  const version = Number(process.argv[4]);
  const proofPath = process.argv[5];
  if (!attemptId || !Number.isSafeInteger(version) || version < 0 || !proofPath) {
    throw new Error("tracker-confirm requires <attempt-id> <expected-version> <proof-json>");
  }
  const proof = JSON.parse(readFileSync(path.resolve(proofPath), "utf8")) as unknown;
  printJson(await callDaemon("tracker-confirm", { attemptId, expectedVersion: version, proof }));
}

async function storeBackup(): Promise<void> {
  const backupPath = process.argv[3];
  if (!backupPath) throw new Error("store-backup requires a destination path");
  const passphrase = await readMaskedSecret("Backup passphrase: ");
  const confirmation = await readMaskedSecret("Confirm backup passphrase: ");
  if (passphrase !== confirmation) throw new Error("Backup passphrase confirmation does not match");
  printJson(await withExclusiveStore((store) => createEncryptedBackup(store, backupPath, passphrase)));
}

async function storeRestore(): Promise<void> {
  const backupPath = process.argv[3];
  if (!backupPath) throw new Error("store-restore requires a backup path");
  const backupPassphrase = await readMaskedSecret("Backup passphrase: ");
  const credentials = await cliCredentialStore();
  const storePassphrase = await credentials.get(CREDENTIAL_ACCOUNTS.databasePassphrase);
  if (!storePassphrase) throw new Error("Database credential is not initialized. Start vocationd first");
  const lock = await acquireSingleInstanceLock({
    lockPath: defaultDaemonLockPath(),
    endpoint: defaultDaemonEndpoint(),
    endpointReachable: daemonEndpointReachable
  });
  const reanchorCheckpoint = process.argv.includes("--reanchor-checkpoint");
  const previousCheckpointDigest = await credentials.get(CREDENTIAL_ACCOUNTS.latestCheckpointDigest);
  try {
    await recoverInterruptedRestore({
      journalPath: `${defaultDatabasePath()}.restore-journal.json`,
      databasePath: defaultDatabasePath(),
      storePassphrase
    });
    printJson(await restoreEncryptedBackup({
      backupPath,
      backupPassphrase,
      databasePath: defaultDatabasePath(),
      storePassphrase,
      replaceExisting: process.argv.includes("--replace"),
      validateStaged: reanchorCheckpoint
        ? (store) => verifyCheckpointRecords(store).then(() => undefined)
        : (store) => verifyCheckpointChain(store, credentials).then(() => undefined),
      afterSwapValidated: async (store) => {
        if (reanchorCheckpoint) {
          const records = await verifyCheckpointRecords(store);
          if (records.latestDigest) {
            await credentials.set(CREDENTIAL_ACCOUNTS.latestCheckpointDigest, records.latestDigest);
          } else {
            await credentials.delete(CREDENTIAL_ACCOUNTS.latestCheckpointDigest);
          }
        }
        await verifyCheckpointChain(store, credentials);
      }
    }));
  } catch (error) {
    if (reanchorCheckpoint) {
      if (previousCheckpointDigest) {
        await credentials.set(CREDENTIAL_ACCOUNTS.latestCheckpointDigest, previousCheckpointDigest);
      } else {
        await credentials.delete(CREDENTIAL_ACCOUNTS.latestCheckpointDigest);
      }
    }
    throw error;
  } finally {
    lock.release();
    await credentials.close?.();
  }
}

async function storeRollback(): Promise<void> {
  const backupArgument = process.argv[3];
  if (!backupArgument) throw new Error("store-rollback requires an automatic rollback backup path");
  if (!process.argv.includes("--replace")) {
    throw new Error("store-rollback requires explicit --replace approval");
  }
  const backupPath = path.resolve(backupArgument);
  const allowedRoot = path.resolve(defaultRuntimeRoot(), "backups");
  const relative = path.relative(allowedRoot, backupPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("store-rollback accepts only backups from the canonical runtime backup directory");
  }
  const credentials = await cliCredentialStore();
  const storePassphrase = await credentials.get(CREDENTIAL_ACCOUNTS.databasePassphrase);
  const rollbackPassphrase = await credentials.get(CREDENTIAL_ACCOUNTS.rollbackBackupPassphrase);
  if (!storePassphrase || !rollbackPassphrase) throw new Error("Rollback credentials are not initialized");
  const lock = await acquireSingleInstanceLock({
    lockPath: defaultDaemonLockPath(),
    endpoint: defaultDaemonEndpoint(),
    endpointReachable: daemonEndpointReachable
  });
  const reanchorCheckpoint = process.argv.includes("--reanchor-checkpoint");
  const previousCheckpointDigest = await credentials.get(CREDENTIAL_ACCOUNTS.latestCheckpointDigest);
  try {
    await recoverInterruptedRestore({
      journalPath: `${defaultDatabasePath()}.restore-journal.json`,
      databasePath: defaultDatabasePath(),
      storePassphrase
    });
    printJson(await restoreEncryptedBackup({
      backupPath,
      backupPassphrase: rollbackPassphrase,
      databasePath: defaultDatabasePath(),
      storePassphrase,
      replaceExisting: true,
      validateStaged: reanchorCheckpoint
        ? (store) => verifyCheckpointRecords(store).then(() => undefined)
        : (store) => verifyCheckpointChain(store, credentials).then(() => undefined),
      afterSwapValidated: async (store) => {
        if (reanchorCheckpoint) {
          const records = await verifyCheckpointRecords(store);
          if (records.latestDigest) {
            await credentials.set(CREDENTIAL_ACCOUNTS.latestCheckpointDigest, records.latestDigest);
          } else {
            await credentials.delete(CREDENTIAL_ACCOUNTS.latestCheckpointDigest);
          }
        }
        await verifyCheckpointChain(store, credentials);
      }
    }));
  } catch (error) {
    if (reanchorCheckpoint) {
      if (previousCheckpointDigest) {
        await credentials.set(CREDENTIAL_ACCOUNTS.latestCheckpointDigest, previousCheckpointDigest);
      } else {
        await credentials.delete(CREDENTIAL_ACCOUNTS.latestCheckpointDigest);
      }
    }
    throw error;
  } finally {
    lock.release();
    await credentials.close?.();
  }
}

function listModes(): void {
  printJson(MODE_NAMES);
}

function listTheories(): void {
  printJson(THEORY_NAMES);
}

function listDimensions(): void {
  printJson(DIMENSION_IDS);
}

function privacyGuidance(): void {
  console.log("Use ignored local state for real profile data. Public examples must stay synthetic.");
}

function governanceScope(): void {
  console.log("Individual decision support only. Employer side ranking, filtering, rejection, or hiring decisions are out of scope.");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  switch (command) {
  case "help":
    help();
    break;
  case "doctor":
    doctor();
    break;
  case "metrics":
    printJson(metrics());
    break;
  case "validate-state":
    validateState();
    break;
  case "validate-schemas":
    validateSchemas();
    break;
  case "selfcheck":
    selfcheck();
    break;
  case "evaluate":
    evaluate();
    break;
  case "demo-score":
    demoScore();
    break;
  case "demo-steelman":
    demoSteelman();
    break;
  case "demo-auto-apply-decision":
    demoAutoApplyDecision();
    break;
  case "demo-auto-apply-allowed":
    demoAutoApplyAllowed();
    break;
  case "export-audit":
    await exportAudit();
    break;
  case "auto-apply-status":
    await autoApplyStatus();
    break;
  case "auto-apply-kill":
    await autoApplyKill();
    break;
  case "auto-apply-rearm":
    await autoApplyRearm();
    break;
  case "auto-apply-enable":
    await autoApplyEnable();
    break;
  case "auto-apply-evaluate":
    await autoApplyEvaluate();
    break;
  case "list-modes":
    listModes();
    break;
  case "list-theories":
    listTheories();
    break;
  case "list-dimensions":
    listDimensions();
    break;
  case "privacy-guidance":
    privacyGuidance();
    break;
  case "governance-scope":
    governanceScope();
    break;
  case "demo-career-twin":
    demoCareerTwin();
    break;
  case "demo-portfolio":
    demoPortfolio();
    break;
  case "demo-opportunity-intake":
    demoOpportunityIntake();
    break;
  case "demo-skill-coach":
    demoSkillCoach();
    break;
  case "demo-advisory":
    await demoAdvisory();
    break;
  case "benchmark":
    benchmark();
    break;
  case "list-workers":
    printJson(WORKER_ROLES);
    break;
  case "daemon-status":
    await daemonStatus();
    break;
  case "daemon-stop":
    await daemonStop();
    break;
  case "legacy-import-plan":
    await legacyImportPlan();
    break;
  case "legacy-import-apply":
    await legacyImportApply();
    break;
  case "checkpoint-create":
    await checkpointCreate();
    break;
  case "checkpoint-verify":
    await checkpointVerify();
    break;
  case "approver-list":
    await approverList();
    break;
  case "approver-register":
    await approverRegister();
    break;
  case "approver-revoke":
    await approverRevoke();
    break;
  case "collector-list":
    await collectorList();
    break;
  case "collector-register":
    await collectorRegister();
    break;
  case "collector-revoke":
    await collectorRevoke();
    break;
  case "store-backup":
    await storeBackup();
    break;
  case "store-restore":
    await storeRestore();
    break;
  case "store-rollback":
    await storeRollback();
    break;
  case "store-verify":
  case "store-doctor":
    await storeVerify();
    break;
  case "init":
    await initProduct();
    break;
  case "artifact-import":
    await artifactImport();
    break;
  case "artifact-list":
    await artifactList();
    break;
  case "domain-put":
    await domainPut();
    break;
  case "domain-get":
    await domainGet();
    break;
  case "domain-list":
    await domainList();
    break;
  case "domain-archive":
    await domainArchive();
    break;
  case "onboarding-status":
    await onboardingStatus();
    break;
  case "profile-import-plan":
    await profileImportPlan();
    break;
  case "profile-import-apply":
    await profileImportApply();
    break;
  case "document-render":
    await documentRender();
    break;
  case "tracker-list":
    await trackerList();
    break;
  case "tracker-get":
    await trackerGet();
    break;
  case "tracker-create":
    await trackerCreate();
    break;
  case "tracker-approve":
    await trackerApprove();
    break;
  case "tracker-submit":
    await trackerSubmit();
    break;
  case "tracker-block":
    await trackerBlock();
    break;
  case "tracker-confirm":
    await trackerConfirm();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
