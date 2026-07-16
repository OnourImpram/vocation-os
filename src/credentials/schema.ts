import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SCHEMA_DIR } from "../paths.js";

export const CREDENTIAL_SCHEMA_NAMES = ["credential-passport", "credential-mapping"] as const;
export type CredentialSchemaName = (typeof CREDENTIAL_SCHEMA_NAMES)[number];

export interface CredentialContractValidationResult {
  valid: boolean;
  errors: string[];
}

let cachedValidators: ReadonlyMap<CredentialSchemaName, ValidateFunction> | null = null;

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "schema validation failed"}`);
}

function validators(): ReadonlyMap<CredentialSchemaName, ValidateFunction> {
  if (cachedValidators) return cachedValidators;
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const addFormats = addFormatsModule as unknown as {
    default?: (instance: Ajv) => void;
  };
  const applyFormats = addFormats.default ?? (addFormatsModule as unknown as (instance: Ajv) => void);
  applyFormats(ajv);

  for (const name of CREDENTIAL_SCHEMA_NAMES) {
    const filePath = path.join(SCHEMA_DIR, `${name}.schema.json`);
    ajv.addSchema(JSON.parse(readFileSync(filePath, "utf8")) as AnySchema);
  }

  const compiled = new Map<CredentialSchemaName, ValidateFunction>();
  for (const name of CREDENTIAL_SCHEMA_NAMES) {
    const schemaId = `https://vocation-os.dev/schemas/${name}.schema.json`;
    const validator = ajv.getSchema(schemaId);
    if (!validator) throw new Error(`Compiled credential schema not found: ${schemaId}`);
    compiled.set(name, validator);
  }
  cachedValidators = compiled;
  return compiled;
}

export function validateCredentialContract(
  schemaName: CredentialSchemaName,
  value: unknown
): CredentialContractValidationResult {
  const validator = validators().get(schemaName);
  if (!validator) throw new Error(`Credential contract validator not found: ${schemaName}`);
  const valid = validator(value);
  return { valid, errors: valid ? [] : formatErrors(validator.errors) };
}

export function assertCredentialContract(schemaName: CredentialSchemaName, value: unknown): void {
  const result = validateCredentialContract(schemaName, value);
  if (!result.valid) {
    throw new Error(`${schemaName} validation failed: ${result.errors.join("; ")}`);
  }
}

export function validateCredentialSchemaFiles(): CredentialContractValidationResult {
  try {
    validators();
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
