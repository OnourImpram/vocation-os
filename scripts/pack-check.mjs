#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(tmpdir(), "vocation-pack-check-"));
const packDir = path.join(tempRoot, "pack");
const consumerDir = path.join(tempRoot, "consumer");
const bundledSdkPrefix = "node_modules/@vocation-os/sdk/";

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) return run(process.execPath, [npmExecPath, ...args], cwd);
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args], cwd);
  }
  return run("npm", args, cwd);
}

function outputFor(result) {
  return [
    result.error instanceof Error ? result.error.message : "",
    result.stdout?.trim() ?? "",
    result.stderr?.trim() ?? ""
  ]
    .filter(Boolean)
    .join("\n");
}

function requireSuccess(label, result) {
  if (!result.error && result.status === 0) return result.stdout;
  throw new Error(`${label} failed with status ${String(result.status)}\n${outputFor(result)}`);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function installedPackagePath(packageName) {
  const segments = packageName.split("/");
  const candidates = [
    path.join(consumerDir, "node_modules", ...segments),
    path.join(consumerDir, "node_modules", "vocation-os", "node_modules", ...segments)
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "package.json"))) ?? null;
}

let successMessage = "";
try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  const packOutput = requireSuccess(
    "npm pack",
    runNpm(["pack", "--json", "--pack-destination", packDir], root)
  );
  const packEntries = JSON.parse(packOutput);
  requireCondition(Array.isArray(packEntries) && packEntries.length === 1, "npm pack returned no unique tarball");

  const pack = packEntries[0];
  const files = new Set(pack.files.map((entry) => entry.path));
  const bundled = new Set(pack.bundled ?? []);
  const failures = [];

  for (const requiredFile of [
    "package.json",
    "dist/cli.js",
    "dist/vocationd.js",
    "dist/import/profile-parser-worker.js",
    "schemas/document-ast-v2.schema.json",
    "schemas/profile-import-plan.schema.json",
    "assets/fonts/NotoSans-Regular.ttf",
    "assets/fonts/NotoSans-Bold.ttf",
    "assets/fonts/NotoSans-LICENSE.txt",
    `${bundledSdkPrefix}package.json`,
    `${bundledSdkPrefix}dist/index.js`,
    `${bundledSdkPrefix}dist/index.d.ts`
  ]) {
    if (!files.has(requiredFile)) failures.push(`${requiredFile} is missing from package`);
  }

  if (!bundled.has("@vocation-os/sdk")) failures.push("@vocation-os/sdk is not bundled");
  for (const dependency of bundled) {
    if (dependency !== "@vocation-os/sdk") failures.push(`unexpected bundled dependency: ${dependency}`);
  }

  for (const file of files) {
    if (file.startsWith("dist/test/")) failures.push(`test build leaked into package: ${file}`);
    if (file.startsWith("dist/src/")) failures.push(`nested src build leaked into package: ${file}`);
    if (file.startsWith(".vocationos/")) failures.push(`runtime artifact leaked into package: ${file}`);
    if (file.startsWith("packages/")) failures.push(`workspace source leaked into package: ${file}`);
    if (file.startsWith("node_modules/") && !file.startsWith(bundledSdkPrefix)) {
      failures.push(`unexpected dependency artifact leaked into package: ${file}`);
    }
    if (
      file.startsWith(bundledSdkPrefix) &&
      (file.startsWith(`${bundledSdkPrefix}src/`) || file === `${bundledSdkPrefix}tsconfig.json`)
    ) {
      failures.push(`SDK source leaked into package: ${file}`);
    }
  }

  requireCondition(failures.length === 0, failures.join("\n"));
  const tarballPath = path.join(packDir, pack.filename);
  requireCondition(existsSync(tarballPath), `npm pack did not create ${tarballPath}`);

  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "vocation-pack-consumer",
        version: "1.0.0",
        private: true,
        scripts: {
          "smoke:vocation:help": "vocation help",
          "smoke:vocation:doctor": "vocation doctor",
          "smoke:vocationd:invalid": "vocationd invalid-command"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  requireSuccess(
    "production tarball install",
    runNpm(["install", "--omit=dev", "--no-audit", "--no-fund", tarballPath], consumerDir)
  );
  requireSuccess("production dependency tree", runNpm(["ls", "--omit=dev", "--all"], consumerDir));

  const installedRoot = path.join(consumerDir, "node_modules", "vocation-os");
  const installedManifest = readJson(path.join(installedRoot, "package.json"));
  requireCondition(
    installedManifest.dependencies?.["pdf-lib"] === "1.17.1" &&
      installedManifest.devDependencies?.["pdf-lib"] === undefined,
    "pdf-lib is not a production dependency in the installed package"
  );

  const installedSdk = installedPackagePath("@vocation-os/sdk");
  requireCondition(installedSdk !== null, "bundled @vocation-os/sdk was not installed");
  requireCondition(existsSync(path.join(installedSdk, "dist", "index.js")), "bundled SDK runtime is missing");
  requireCondition(readJson(path.join(installedSdk, "package.json")).private === true, "bundled SDK must remain private");
  requireCondition(installedPackagePath("pdf-lib") !== null, "pdf-lib was omitted from production install");

  for (const devDependency of ["astro", "typescript", "vitest"]) {
    requireCondition(
      installedPackagePath(devDependency) === null,
      `root development dependency was installed in production mode: ${devDependency}`
    );
  }

  requireSuccess(
    "pdf-lib runtime import",
    run(process.execPath, ["--input-type=module", "--eval", "await import('pdf-lib')"], consumerDir)
  );
  const installedParserUrl = pathToFileURL(
    path.join(installedRoot, "dist", "import", "profile-import.js")
  ).href;
  const parserSmoke = `
    const { parseProfileArtifact } = await import(${JSON.stringify(installedParserUrl)});
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const pdfDocument = await PDFDocument.create();
    const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
    const page = pdfDocument.addPage([595, 842]);
    page.drawText("Installed PDF parser smoke", { x: 50, y: 780, size: 12, font });
    const pdf = Buffer.from(await pdfDocument.save({ useObjectStreams: false }));
    const docx = await import("docx");
    const wordDocument = new docx.Document({ sections: [{ children: [new docx.Paragraph("Installed DOCX parser smoke")] }] });
    const word = await docx.Packer.toBuffer(wordDocument);
    const [pdfResult, docxResult] = await Promise.all([
      parseProfileArtifact(pdf, "pdf"),
      parseProfileArtifact(word, "docx")
    ]);
    if (!pdfResult.text.includes("Installed PDF parser smoke")) throw new Error("installed PDF parser failed");
    if (!docxResult.text.includes("Installed DOCX parser smoke")) throw new Error("installed DOCX parser failed");
  `;
  requireSuccess(
    "installed bounded PDF and DOCX parser",
    run(process.execPath, ["--input-type=module", "--eval", parserSmoke], consumerDir)
  );
  requireSuccess(
    "installed vocation help",
    runNpm(["run", "--silent", "smoke:vocation:help"], consumerDir)
  );
  requireSuccess(
    "installed vocation doctor",
    runNpm(["run", "--silent", "smoke:vocation:doctor"], consumerDir)
  );

  const invalidDaemon = runNpm(["run", "--silent", "smoke:vocationd:invalid"], consumerDir);
  requireCondition(invalidDaemon.status !== 0, "vocationd accepted an invalid command");
  requireCondition(
    outputFor(invalidDaemon).includes("Unknown vocationd command: invalid-command"),
    `vocationd invalid-command did not fail closed as expected\n${outputFor(invalidDaemon)}`
  );

  successMessage =
    "pack check passed: actual tarball, bundled private SDK, production-only install, external CLI, and bounded PDF/DOCX parser smokes verified";
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(successMessage);
