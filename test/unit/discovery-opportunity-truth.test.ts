import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import * as addFormatsModule from "ajv-formats/dist/index.js";
import { describe, expect, it } from "vitest";
import {
  OPPORTUNITY_TRUTH_FIELDS,
  OPPORTUNITY_TRUTH_STATES,
  assertOpportunityTruthRecord,
  assertOpportunityTruthRecordActionable,
  createOpportunityTruthRecord,
  type OpportunityFieldTruthInput,
  type OpportunityTruthFieldName,
  type OpportunityTruthRecord
} from "../../src/discovery/opportunity-truth.js";

const ASSESSED_AT = "2026-07-14T10:00:00.000Z";
const OBSERVED_AT = "2026-07-14T09:00:00.000Z";

function evidence(letter = "A", observedAt = OBSERVED_AT) {
  return {
    observationId: `OBS-${letter.repeat(32)}`,
    pointer: "$.jobPosting.field",
    observedAt
  };
}

function field(overrides: Partial<OpportunityFieldTruthInput> = {}): OpportunityFieldTruthInput {
  return {
    state: "observed",
    value: "Verified fixture value",
    evidence: [evidence()],
    observedAt: OBSERVED_AT,
    recencyPolicy: {
      policyId: "discovery.default-v1",
      maxAgeMs: 24 * 60 * 60_000,
      maxFutureSkewMs: 5 * 60_000,
      onExpiry: "stale"
    },
    rationale: "Directly observed in the governed source fixture.",
    ...overrides
  };
}

function fields(
  overrides: Partial<Record<OpportunityTruthFieldName, OpportunityFieldTruthInput>> = {}
): Record<OpportunityTruthFieldName, OpportunityFieldTruthInput> {
  return {
    salary: field({ value: { currency: "USD", minimum: 90000, maximum: 110000 } }),
    remoteConditions: field({ value: { mode: "remote", eligibleCountries: ["TR", "GR"] } }),
    workAuthorization: field({ value: "EU work authorization required" }),
    licensing: field({ value: "No professional license required" }),
    location: field({ value: "Remote, Europe" }),
    deadline: field({ value: "2026-08-01T23:59:59.000Z" }),
    ...overrides
  };
}

function record(overrides: Partial<Parameters<typeof createOpportunityTruthRecord>[0]> = {}) {
  return createOpportunityTruthRecord({
    opportunityKey: "greenhouse:example:job-42",
    assessedAt: ASSESSED_AT,
    mandatoryFields: [...OPPORTUNITY_TRUTH_FIELDS],
    fields: fields(),
    ...overrides
  });
}

describe("OpportunityTruthRecord", () => {
  it("exports exactly the approved truth states and governed fields", () => {
    expect(OPPORTUNITY_TRUTH_STATES).toEqual([
      "observed",
      "inferred",
      "consistent",
      "conflicting",
      "stale",
      "unresolved"
    ]);
    expect(OPPORTUNITY_TRUTH_FIELDS).toEqual([
      "salary",
      "remoteConditions",
      "workAuthorization",
      "licensing",
      "location",
      "deadline"
    ]);
  });

  it("creates an actionable deterministic record only with evidence and recency policy on every field", () => {
    const first = record();
    const second = record();
    expect(second).toEqual(first);
    expect(first.disposition).toBe("actionable");
    expect(first.blockers).toEqual([]);
    for (const fieldName of OPPORTUNITY_TRUTH_FIELDS) {
      expect(first.fields[fieldName].evidence).toHaveLength(1);
      expect(first.fields[fieldName].observedAt).toBe(OBSERVED_AT);
      expect(first.fields[fieldName].recencyPolicy.onExpiry).toBe("stale");
    }
    expect(() => assertOpportunityTruthRecord(first)).not.toThrow();
    expect(() => assertOpportunityTruthRecordActionable(first)).not.toThrow();
  });

  it("fails closed on conflicting evidence even when the field is not mandatory", () => {
    const conflicting = field({
      state: "conflicting",
      value: null,
      evidence: [evidence("A"), evidence("B", "2026-07-14T09:01:00.000Z")],
      observedAt: "2026-07-14T09:01:00.000Z",
      rationale: "Two governed sources report incompatible salary terms."
    });
    const result = record({ mandatoryFields: ["location"], fields: fields({ salary: conflicting }) });
    expect(result).toMatchObject({
      disposition: "blocked",
      blockers: [{ field: "salary", code: "conflicting-evidence" }]
    });
    expect(() => assertOpportunityTruthRecordActionable(result)).toThrow(/fails closed/);
  });

  it("fails closed when a mandatory field is unresolved", () => {
    const unresolved = field({
      state: "unresolved",
      value: null,
      rationale: "The source does not state work authorization requirements."
    });
    const result = record({
      mandatoryFields: ["workAuthorization"],
      fields: fields({ workAuthorization: unresolved })
    });
    expect(result.blockers).toEqual([{ field: "workAuthorization", code: "mandatory-unresolved" }]);
    expect(result.disposition).toBe("blocked");
  });

  it("derives stale state from recency policy and blocks a mandatory stale field", () => {
    const staleObservedAt = "2026-07-12T09:00:00.000Z";
    const result = record({
      mandatoryFields: ["deadline"],
      fields: fields({
        deadline: field({
          value: "2026-08-01T23:59:59.000Z",
          evidence: [evidence("C", staleObservedAt)],
          observedAt: staleObservedAt,
          recencyPolicy: {
            policyId: "deadline.hourly-v1",
            maxAgeMs: 60 * 60_000,
            maxFutureSkewMs: 5 * 60_000,
            onExpiry: "stale"
          }
        })
      })
    });
    expect(result.fields.deadline.state).toBe("stale");
    expect(result.blockers).toEqual([{ field: "deadline", code: "mandatory-stale" }]);
  });

  it("rejects missing evidence and persisted payload tampering", () => {
    expect(() => record({ fields: fields({ salary: field({ evidence: [] }) }) })).toThrow(/evidence pointers/);
    const valid = record();
    const tampered = { ...valid, disposition: "blocked" } as OpportunityTruthRecord;
    expect(() => assertOpportunityTruthRecord(tampered)).toThrow(/integrity check failed/);
  });

  it("validates generated records against the public schema and rejects aliases", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const addFormats = (addFormatsModule as unknown as { default?: (instance: Ajv) => void }).default
      ?? (addFormatsModule as unknown as (instance: Ajv) => void);
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(
      path.resolve("schemas/discovery-opportunity-truth-record.schema.json"),
      "utf8"
    )) as AnySchema;
    const validate = ajv.compile(schema);
    const valid = record();
    expect(validate(valid), ajv.errorsText(validate.errors)).toBe(true);
    const alias = {
      ...valid,
      fields: {
        ...valid.fields,
        salary: { ...valid.fields.salary, state: "unknown" }
      }
    };
    expect(validate(alias)).toBe(false);
  });
});

