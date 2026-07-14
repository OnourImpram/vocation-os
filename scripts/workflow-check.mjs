import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowDir = ".github/workflows";
const shaRefPattern = /^[a-f0-9]{40}$/;
const failures = [];

const workflowFiles = (await readdir(workflowDir))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();

if (workflowFiles.length === 0) {
  failures.push("No GitHub workflow files found.");
}

for (const file of workflowFiles) {
  const path = join(workflowDir, file);
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const uses = line.match(/^\s*uses:\s*([^#\s]+)(?:\s*#.*)?$/);
    if (!uses) {
      continue;
    }

    const reference = uses[1];
    const atIndex = reference.lastIndexOf("@");
    if (atIndex === -1) {
      failures.push(`${path}:${index + 1} uses action without ref: ${reference}`);
      continue;
    }

    const ref = reference.slice(atIndex + 1);
    if (!shaRefPattern.test(ref)) {
      failures.push(`${path}:${index + 1} uses action without pinned SHA: ${reference}`);
    }
  }

  if (text.includes("actions/setup-node") && !text.includes("node-version-file: .nvmrc")) {
    failures.push(`${path} uses setup-node without node-version-file: .nvmrc`);
  }
}

if (failures.length > 0) {
  console.error("Workflow check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Workflow check passed for ${workflowFiles.length} workflow files.`);
