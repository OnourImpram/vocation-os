import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA_DIR as PACKAGE_SCHEMA_DIR } from "./paths.js";

export const SCHEMA_DIR = PACKAGE_SCHEMA_DIR;

export const SCHEMA_NAMES = [
  "evidence-status",
  "claim",
  "claim-graph",
  "application-packet",
  "auto-apply-config",
  "action-ledger-entry",
  "mode-output",
  "opportunity-score",
  "advisory-note",
  "coaching-plan",
  "opportunity-record",
  "opportunity-intake",
  "submission-proof",
  "application-attempt"
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

let cachedValidators: Map<SchemaName, ValidateFunction> | null = null;

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message ?? "schema validation failed"}`;
  });
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function loadSchemas(schemaDir = SCHEMA_DIR): Map<SchemaName, unknown> {
  if (!existsSync(schemaDir)) {
    throw new Error(`Schema directory not found: ${schemaDir}`);
  }

  const schemas = new Map<SchemaName, unknown>();
  for (const schemaName of SCHEMA_NAMES) {
    const filePath = path.join(schemaDir, `${schemaName}.schema.json`);
    schemas.set(schemaName, readJson(filePath));
  }
  return schemas;
}

export function createAjv(schemaDir = SCHEMA_DIR): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    allowUnionTypes: true
  });
  const addFormats = (addFormatsModule as unknown as { default?: (instance: Ajv) => void });
  const applyFormats = addFormats.default ?? (addFormatsModule as unknown as (instance: Ajv) => void);
  applyFormats(ajv);

  const schemas = loadSchemas(schemaDir);
  for (const schema of schemas.values()) {
    ajv.addSchema(schema as AnySchema);
  }

  return ajv;
}

export function getValidators(schemaDir = SCHEMA_DIR): Map<SchemaName, ValidateFunction> {
  if (cachedValidators && schemaDir === SCHEMA_DIR) {
    return cachedValidators;
  }

  const ajv = createAjv(schemaDir);
  const validators = new Map<SchemaName, ValidateFunction>();

  for (const schemaName of SCHEMA_NAMES) {
    const schemaId = `https://vocation-os.dev/schemas/${schemaName}.schema.json`;
    const validator = ajv.getSchema(schemaId);
    if (!validator) {
      throw new Error(`Compiled schema not found: ${schemaId}`);
    }
    validators.set(schemaName, validator);
  }

  if (schemaDir === SCHEMA_DIR) {
    cachedValidators = validators;
  }
  return validators;
}

export function validateAgainstSchema(schemaName: SchemaName, value: unknown): SchemaValidationResult {
  const validator = getValidators().get(schemaName);
  if (!validator) {
    throw new Error(`Validator not found: ${schemaName}`);
  }
  const valid = validator(value);
  return {
    valid,
    errors: valid ? [] : formatErrors(validator.errors)
  };
}

export function assertSchema(schemaName: SchemaName, value: unknown): void {
  const result = validateAgainstSchema(schemaName, value);
  if (!result.valid) {
    throw new Error(`${schemaName} validation failed: ${result.errors.join("; ")}`);
  }
}

export function validateAllSchemaFiles(schemaDir = SCHEMA_DIR): SchemaValidationResult {
  const files = readdirSync(schemaDir).filter((file) => file.endsWith(".schema.json"));
  const expected = new Set(SCHEMA_NAMES.map((name) => `${name}.schema.json`));
  const errors: string[] = [];

  for (const expectedFile of expected) {
    if (!files.includes(expectedFile)) {
      errors.push(`Missing schema file: ${expectedFile}`);
    }
  }

  try {
    createAjv(schemaDir);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
