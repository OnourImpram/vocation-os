import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..");
export const SCHEMA_DIR = path.join(PACKAGE_ROOT, "schemas");
export const EXAMPLES_DIR = path.join(PACKAGE_ROOT, "examples");
