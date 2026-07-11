import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
const temporaryCwd = mkdtempSync(path.join(tmpdir(), "vocation-cli-smoke-"));

function execute(command, expectedText) {
  const result = spawnSync(process.execPath, [cliPath, command], {
    cwd: temporaryCwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}: ${result.stderr}`);
  }
  if (!result.stdout.includes(expectedText)) {
    throw new Error(`${command} output did not include ${JSON.stringify(expectedText)}`);
  }
}

try {
  execute("help", "VocationOS");
  execute("doctor", '"schemaValid": true');
  process.stdout.write("CLI subprocess smoke passed from an external working directory.\n");
} finally {
  rmSync(temporaryCwd, { recursive: true, force: true });
}
