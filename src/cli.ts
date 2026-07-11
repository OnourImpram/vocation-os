#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WORKER_ROLES } from "./agent-controller.js";
import { defaultLedgerPath, summarizeLedger } from "./action-ledger.js";
import { createApprovalReference, type TrustedApprover } from "./approval.js";
import { defaultAutoApplyConfigPath, loadAutoApplyConfig, saveAutoApplyConfig } from "./auto-apply-config.js";
import { decideAutoApply, defaultAutoApplyConfig, enableAutoApply, engageKillSwitch, rearmAutoApply } from "./auto-apply.js";
import { OfflineTemplateClient, generateAdvisoryNote } from "./advisor.js";
import { createVocationBenchManifest } from "./benchmark/vocation-bench.js";
import { createCareerTwin } from "./career-twin.js";
import { validateApplicationPacket, validateClaimGraph } from "./claim-graph.js";
import { buildCoachingPlan, PHT_SKILLS } from "./coach.js";
import { runEvaluator } from "./evaluator.js";
import { computeActionIntentHash } from "./hash.js";
import { runDeepFit, runMode } from "./modes.js";
import { createOpportunityRecord, evaluateOpportunityIntake } from "./opportunity.js";
import { EXAMPLES_DIR, PACKAGE_ROOT } from "./paths.js";
import { evaluateCareerPortfolio, PORTFOLIO_OBJECTIVES, type PortfolioWeights } from "./portfolio.js";
import { demoDimensions, DIMENSION_IDS, scoreOpportunity } from "./rubric.js";
import { SCHEMA_NAMES, validateAllSchemaFiles, validateAgainstSchema } from "./schema.js";
import { defaultStateDir, readState, validateStateDirectory, writeState } from "./state.js";
import { EncryptedEventStore } from "./storage/encrypted-event-store.js";
import { THEORY_NAMES } from "./theory.js";
import { CLI_COMMANDS, HIGH_STAKES_FLAGS, MODE_NAMES, PRODUCT_NAME, TAGLINE, type ApplicationPacket, type ClaimGraph, type HighStakesFlags } from "./types.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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

function autoApplyStatus(): void {
  printJson({ path: defaultAutoApplyConfigPath(), config: loadAutoApplyConfig() });
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

async function storeDoctor(): Promise<void> {
  const databasePath = process.argv[3];
  const passphrase = process.env["VOCATION_STORE_PASSPHRASE"];
  if (!databasePath || !existsSync(databasePath)) throw new Error("store-doctor requires an existing database path");
  if (!passphrase) throw new Error("VOCATION_STORE_PASSPHRASE is required and is never printed");
  const store = await EncryptedEventStore.open(databasePath, passphrase);
  try {
    const events = await store.readAll();
    printJson({ valid: true, path: path.resolve(databasePath), eventCount: events.length });
  } finally {
    await store.close();
  }
}

function autoApplyKill(): void {
  const updated = engageKillSwitch(loadAutoApplyConfig(), "operator", "manual kill command");
  saveAutoApplyConfig(updated);
  printJson(updated);
}

function autoApplyRearm(): void {
  const token = process.argv[3] ?? "";
  try {
    const updated = rearmAutoApply(loadAutoApplyConfig(), token);
    saveAutoApplyConfig(updated);
    printJson(updated);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function autoApplyEnable(): void {
  const mode = process.argv[3] === "auto" ? "auto" : "draft-only";
  try {
    const updated = enableAutoApply(loadAutoApplyConfig(), mode);
    saveAutoApplyConfig(updated);
    printJson(updated);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function validateState(): void {
  const report = validateStateDirectory(defaultStateDir());
  printJson(report);
  if (!report.valid) {
    process.exitCode = 1;
  }
}

function exportAudit(): void {
  printJson(summarizeLedger(defaultLedgerPath()));
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
    exportAudit();
    break;
  case "auto-apply-status":
    autoApplyStatus();
    break;
  case "auto-apply-kill":
    autoApplyKill();
    break;
  case "auto-apply-rearm":
    autoApplyRearm();
    break;
  case "auto-apply-enable":
    autoApplyEnable();
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
  case "store-doctor":
    await storeDoctor();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
}
