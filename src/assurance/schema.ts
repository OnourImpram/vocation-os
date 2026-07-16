import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SCHEMA_DIR } from "../paths.js";

export const ASSURANCE_SCHEMA_NAMES = ["assurance-case", "assurance-document-ast"] as const;
export type AssuranceSchemaName = (typeof ASSURANCE_SCHEMA_NAMES)[number];

export interface AssuranceSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

let cachedValidators: ReadonlyMap<AssuranceSchemaName, ValidateFunction> | null = null;

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "schema validation failed"}`);
}

function validators(): ReadonlyMap<AssuranceSchemaName, ValidateFunction> {
  if (cachedValidators) return cachedValidators;
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const addFormats = addFormatsModule as unknown as {
    default?: (instance: Ajv) => void;
  };
  const applyFormats = addFormats.default ?? (addFormatsModule as unknown as (instance: Ajv) => void);
  applyFormats(ajv);

  for (const name of ASSURANCE_SCHEMA_NAMES) {
    const filePath = path.join(SCHEMA_DIR, `${name}.schema.json`);
    ajv.addSchema(JSON.parse(readFileSync(filePath, "utf8")) as AnySchema);
  }

  const compiled = new Map<AssuranceSchemaName, ValidateFunction>();
  for (const name of ASSURANCE_SCHEMA_NAMES) {
    const schemaId = `https://vocation-os.dev/schemas/${name}.schema.json`;
    const validator = ajv.getSchema(schemaId);
    if (!validator) throw new Error(`Compiled assurance schema not found: ${schemaId}`);
    compiled.set(name, validator);
  }
  cachedValidators = compiled;
  return compiled;
}

export function validateAssuranceSchema(
  schemaName: AssuranceSchemaName,
  value: unknown
): AssuranceSchemaValidationResult {
  const validator = validators().get(schemaName);
  if (!validator) throw new Error(`Assurance validator not found: ${schemaName}`);
  const valid = validator(value);
  return { valid, errors: valid ? [] : formatErrors(validator.errors) };
}

export function assertAssuranceSchema(schemaName: AssuranceSchemaName, value: unknown): void {
  const result = validateAssuranceSchema(schemaName, value);
  if (!result.valid) {
    throw new Error(`${schemaName} validation failed: ${result.errors.join("; ")}`);
  }
}

export function validateAssuranceSchemaFiles(): AssuranceSchemaValidationResult {
  try {
    validators();
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
