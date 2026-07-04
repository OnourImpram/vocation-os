import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  ".vocationos"
]);

export function walkFiles(root = process.cwd()) {
  const files = [];
  function visit(current) {
    if (!existsSync(current)) {
      return;
    }
    const stat = statSync(current);
    if (stat.isDirectory()) {
      const name = path.basename(current);
      if (IGNORED_DIRS.has(name)) {
        return;
      }
      for (const child of readdirSync(current)) {
        visit(path.join(current, child));
      }
      return;
    }
    if (stat.isFile()) {
      files.push(current);
    }
  }
  visit(root);
  return files;
}

export function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}
