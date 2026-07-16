import { describe, expect, it } from "vitest";
import {
  LIVENESS_STATES,
  assertLivenessAssessment,
  assessSourceLiveness,
  DEFAULT_LIVENESS_POLICY,
  type LivenessAssessment
} from "../../src/discovery/liveness.js";
import { providerManifestById } from "../../src/discovery/providers.js";
import {
  assertSourceObservation,
  createSourceObservation,
  type JsonValue,
  type SourceAvailability,
  type SourceObservationInput
} from "../../src/discovery/source-observation.js";

const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const SOURCE_URL = "https://boards-api.greenhouse.io/v1/boards/example/jobs/42";
const PROVIDER_VERSION = providerManifestById("greenhouse").egress.version;
const ASSESSED_AT = new Date("2026-07-14T10:00:00.000Z");

function availableInput(overrides: Partial<SourceObservationInput> = {}): SourceObservationInput {
  return {
    providerId: "greenhouse",
    providerManifestVersion: PROVIDER_VERSION,
    sourceKey: "greenhouse:job-42",
    requestedUrl: SOURCE_URL,
    finalUrl: SOURCE_URL,
    observedAt: "2026-07-14T09:59:00.000Z",
    availability: "available",
    httpStatus: 200,
    contentType: "application/json",
    bodyDigest: CONTENT_HASH,
    cacheState: "bypass",
    redirectCount: 0,
    fields: [{ field: "roleTitle", value: "AI Engineer", confidence: "high", evidencePointer: "$.title" }],
    uncertainty: [],
    ...overrides
  };
}

function unavailableInput(
  availability: SourceAvailability,
  httpStatus: number | null,
  overrides: Partial<SourceObservationInput> = {}
): SourceObservationInput {
  return availableInput({
    availability,
    httpStatus,
    finalUrl: null,
    contentType: null,
    bodyDigest: null,
    fields: [],
    uncertainty: [`Retrieval ended as ${availability}`],
    ...overrides
  });
}

function observation(observedAt: string, availability: SourceAvailability, httpStatus: number | null) {
  const available = availability === "available";
  return createSourceObservation({
    providerId: "greenhouse",
    providerManifestVersion: PROVIDER_VERSION,
    sourceKey: "greenhouse:job-42",
    requestedUrl: SOURCE_URL,
    finalUrl: available ? SOURCE_URL : null,
    observedAt,
    availability,
    httpStatus,
    contentType: available ? "application/json" : null,
    bodyDigest: available ? CONTENT_HASH : null,
    cacheState: "bypass",
    redirectCount: 0,
    fields: available
      ? [{ field: "roleTitle", value: "AI Engineer", confidence: "high", evidencePointer: "$.title" }]
      : [],
    uncertainty: available ? [] : [`Retrieval ended as ${availability}`]
  });
}

describe("source observations and liveness", () => {
  it("exports exactly the approved public liveness states", () => {
    expect(LIVENESS_STATES).toEqual(["live", "closed", "stale", "unreachable", "unresolved"]);
  });

  it("creates deterministic observation identities with provider manifest provenance", () => {
    const left = observation("2026-07-14T09:59:00.000Z", "available", 200);
    const right = observation("2026-07-14T09:59:00.000Z", "available", 200);
    expect(left).toEqual(right);
    expect(left).toMatchObject({ providerManifestVersion: PROVIDER_VERSION, schemaVersion: "1.0.0" });
  });

  it("classifies only recent successful evidence as live", () => {
    const result = assessSourceLiveness(
      [observation("2026-07-14T09:59:00.000Z", "available", 200)],
      DEFAULT_LIVENESS_POLICY,
      ASSESSED_AT
    );
    expect(result).toMatchObject({ state: "live", confidence: "high" });
  });

  it("keeps one 404 unresolved and requires consecutive confirmation", () => {
    const one = observation("2026-07-14T09:59:00.000Z", "not-found", 404);
    expect(assessSourceLiveness([one], DEFAULT_LIVENESS_POLICY, ASSESSED_AT)).toMatchObject({
      state: "unresolved",
      confidence: "low"
    });

    const earlier = observation("2026-07-14T09:55:00.000Z", "not-found", 404);
    expect(assessSourceLiveness([earlier, one], DEFAULT_LIVENESS_POLICY, ASSESSED_AT)).toMatchObject({
      state: "closed",
      confidence: "high"
    });
    expect(assessSourceLiveness([earlier, one], DEFAULT_LIVENESS_POLICY, ASSESSED_AT).reasons)
      .toContain("Retrieval ended as not-found");
  });

  it("does not combine fresh and expired negative evidence into a closure claim", () => {
    const recent = observation("2026-07-14T09:59:00.000Z", "not-found", 404);
    const expired = observation("2026-07-13T20:00:00.000Z", "not-found", 404);
    const result = assessSourceLiveness([expired, recent], DEFAULT_LIVENESS_POLICY, ASSESSED_AT);
    expect(result).toMatchObject({ state: "unresolved", confidence: "low" });
    expect(result.evidenceObservationIds).toEqual([recent.observationId]);
  });

  it("treats a transport failure after prior success as unreachable rather than inferred liveness", () => {
    const success = observation("2026-07-14T09:55:00.000Z", "available", 200);
    const timeout = observation("2026-07-14T09:59:00.000Z", "transport-error", null);
    const result = assessSourceLiveness([success, timeout], DEFAULT_LIVENESS_POLICY, ASSESSED_AT);
    expect(result).toMatchObject({ state: "unreachable", confidence: "low" });
    expect(result.evidenceObservationIds).toEqual([timeout.observationId]);
  });

  it("maps access and rate gates to unreachable and parse uncertainty to unresolved", () => {
    const access = observation("2026-07-14T09:59:00.000Z", "access-denied", null);
    const rate = observation("2026-07-14T09:59:00.000Z", "rate-limited", null);
    const parsed = createSourceObservation({
      providerId: "greenhouse",
      providerManifestVersion: PROVIDER_VERSION,
      sourceKey: "greenhouse:job-42",
      requestedUrl: SOURCE_URL,
      finalUrl: SOURCE_URL,
      observedAt: "2026-07-14T09:59:00.000Z",
      availability: "parse-error",
      httpStatus: 200,
      contentType: "application/json",
      bodyDigest: CONTENT_HASH,
      cacheState: "bypass",
      redirectCount: 0,
      fields: [],
      uncertainty: ["Fixture parsing failed without a liveness claim"]
    });
    expect(assessSourceLiveness([access], DEFAULT_LIVENESS_POLICY, ASSESSED_AT).state).toBe("unreachable");
    expect(assessSourceLiveness([rate], DEFAULT_LIVENESS_POLICY, ASSESSED_AT).state).toBe("unreachable");
    expect(assessSourceLiveness([parsed], DEFAULT_LIVENESS_POLICY, ASSESSED_AT).state).toBe("unresolved");
  });

  it("recomputes persisted liveness identities and rejects tampering", () => {
    const result = assessSourceLiveness(
      [observation("2026-07-14T09:59:00.000Z", "available", 200)],
      DEFAULT_LIVENESS_POLICY,
      ASSESSED_AT
    );
    expect(() => assertLivenessAssessment(result)).not.toThrow();
    const tampered = { ...result, state: "closed" } as LivenessAssessment;
    expect(() => assertLivenessAssessment(tampered)).toThrow(/integrity check failed/);
    const tamperedId = { ...result, assessmentId: `LIVE-${"0".repeat(32)}` } as LivenessAssessment;
    expect(() => assertLivenessAssessment(tamperedId)).toThrow(/integrity check failed/);
  });

  it("requires confirmation even for an explicit 410", () => {
    const gone = observation("2026-07-14T09:59:00.000Z", "gone", 410);
    expect(assessSourceLiveness([gone], DEFAULT_LIVENESS_POLICY, ASSESSED_AT)).toMatchObject({
      state: "unresolved",
      confidence: "low"
    });
    const earlier = observation("2026-07-14T09:50:00.000Z", "gone", 410);
    expect(assessSourceLiveness([gone, earlier], DEFAULT_LIVENESS_POLICY, ASSESSED_AT)).toMatchObject({
      state: "closed",
      confidence: "high"
    });
  });

  it("rejects inconsistent availability and HTTP status", () => {
    expect(() => createSourceObservation({
      providerId: "greenhouse",
      providerManifestVersion: PROVIDER_VERSION,
      sourceKey: "greenhouse:job-42",
      requestedUrl: SOURCE_URL,
      finalUrl: SOURCE_URL,
      observedAt: "2026-07-14T09:59:00.000Z",
      availability: "available",
      httpStatus: 404,
      contentType: "application/json",
      bodyDigest: CONTENT_HASH,
      cacheState: "bypass",
      redirectCount: 0,
      fields: [],
      uncertainty: []
    })).toThrow("2xx");
  });

  it("normalizes, sorts, freezes, and integrity-checks nested observation evidence", () => {
    const result = createSourceObservation(availableInput({
      sourceKey: "  greenhouse:job-42  ",
      contentType: "Application/JSON; charset=utf-8",
      fields: [
        {
          field: "metadata",
          value: { remote: true, scores: [1, 0.5, null], nested: { label: "verified" } },
          confidence: "medium",
          evidencePointer: "  $.metadata  "
        },
        { field: "company", value: "Example Research", confidence: "high", evidencePointer: "$.company" }
      ],
      uncertainty: [" partial extraction ", "partial extraction", ""]
    }));
    expect(result.sourceKey).toBe("greenhouse:job-42");
    expect(result.contentType).toBe("application/json");
    expect(result.fields.map((field) => field.field)).toEqual(["company", "metadata"]);
    expect(result.uncertainty).toEqual(["partial extraction"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.fields[1]?.value)).toBe(true);
    expect(() => assertSourceObservation(result)).not.toThrow();

    expect(() => assertSourceObservation({ ...result, observationId: "OBS-invalid" })).toThrow(/envelope/);
    expect(() => assertSourceObservation({ ...result, sourceKey: "greenhouse:tampered" })).toThrow(/integrity/);
  });

  it("rejects malformed provenance, envelope, and extracted field inputs", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const cases: ReadonlyArray<{
      readonly overrides: Partial<SourceObservationInput>;
      readonly expected: RegExp;
    }> = [
      { overrides: { providerManifestVersion: "9.9.9" }, expected: /version mismatch/ },
      { overrides: { sourceKey: " " }, expected: /sourceKey is invalid/ },
      { overrides: { requestedUrl: "not a URL" }, expected: /valid URL/ },
      { overrides: { requestedUrl: "http://boards-api.greenhouse.io/jobs" }, expected: /credential-free HTTPS/ },
      { overrides: { requestedUrl: "https://boards-api.greenhouse.io./jobs" }, expected: /trailing dot/ },
      { overrides: { finalUrl: "https://user:secret@boards-api.greenhouse.io/jobs" }, expected: /credential-free HTTPS/ },
      { overrides: { observedAt: "2026-07-14T09:59:00Z" }, expected: /canonical ISO/ },
      { overrides: { contentType: "not-a-content-type" }, expected: /content type is invalid/ },
      { overrides: { bodyDigest: "sha256:invalid" }, expected: /body digest is invalid/ },
      { overrides: { cacheState: "invalid" as SourceObservationInput["cacheState"] }, expected: /cache state is invalid/ },
      { overrides: { redirectCount: 11 }, expected: /redirect count is invalid/ },
      {
        overrides: {
          fields: [
            { field: "company", value: "A", confidence: "high", evidencePointer: "$.a" },
            { field: "company", value: "B", confidence: "low", evidencePointer: "$.b" }
          ]
        },
        expected: /field names must be unique/
      },
      {
        overrides: { fields: [{ field: "Invalid Field", value: "A", confidence: "high", evidencePointer: "$.a" }] },
        expected: /Invalid observed field name/
      },
      {
        overrides: {
          fields: [{
            field: "company",
            value: "A",
            confidence: "invalid" as SourceObservationInput["fields"][number]["confidence"],
            evidencePointer: "$.a"
          }]
        },
        expected: /Invalid confidence/
      },
      {
        overrides: { fields: [{ field: "company", value: "A", confidence: "high", evidencePointer: " " }] },
        expected: /Invalid evidence pointer/
      },
      {
        overrides: {
          fields: [{ field: "company", value: Number.NaN as unknown as JsonValue, confidence: "high", evidencePointer: "$.a" }]
        },
        expected: /not JSON-safe/
      },
      {
        overrides: {
          fields: [{ field: "company", value: new Date() as unknown as JsonValue, confidence: "high", evidencePointer: "$.a" }]
        },
        expected: /not JSON-safe/
      },
      {
        overrides: {
          fields: [{ field: "company", value: circular as unknown as JsonValue, confidence: "high", evidencePointer: "$.a" }]
        },
        expected: /not JSON-safe/
      },
      { overrides: { uncertainty: ["x".repeat(1_025)] }, expected: /too long/ },
      {
        overrides: { availability: "invalid" as SourceAvailability },
        expected: /availability is invalid/
      }
    ];
    for (const testCase of cases) {
      expect(() => createSourceObservation(availableInput(testCase.overrides))).toThrow(testCase.expected);
    }
  });

  it("enforces every availability and HTTP evidence contract", () => {
    const cases: ReadonlyArray<{
      readonly input: SourceObservationInput;
      readonly expected: RegExp;
    }> = [
      { input: availableInput({ httpStatus: 99 }), expected: /invalid HTTP status/ },
      { input: unavailableInput("not-found", 410), expected: /require HTTP 404/ },
      { input: unavailableInput("gone", 404), expected: /require HTTP 410/ },
      { input: unavailableInput("access-denied", 500), expected: /status 401 or 403/ },
      { input: unavailableInput("rate-limited", 500), expected: /status 429/ },
      { input: unavailableInput("transport-error", 200), expected: /cannot claim an HTTP status/ },
      { input: unavailableInput("parse-error", 404), expected: /retrieved 2xx response/ },
      { input: unavailableInput("uncertain", null, { uncertainty: [] }), expected: /explicit uncertainty/ },
      {
        input: unavailableInput("uncertain", null, {
          fields: [{ field: "company", value: "Example", confidence: "high", evidencePointer: "$.company" }]
        }),
        expected: /cannot assert extracted fields/
      }
    ];
    for (const testCase of cases) {
      expect(() => createSourceObservation(testCase.input)).toThrow(testCase.expected);
    }
  });

  it("handles empty, stale, uncertain, future, and mixed-source liveness evidence", () => {
    expect(assessSourceLiveness([], DEFAULT_LIVENESS_POLICY, ASSESSED_AT)).toMatchObject({
      sourceKey: null,
      state: "unresolved"
    });
    expect(assessSourceLiveness(
      [observation("2026-07-13T08:00:00.000Z", "available", 200)],
      DEFAULT_LIVENESS_POLICY,
      ASSESSED_AT
    ).state).toBe("stale");
    expect(assessSourceLiveness(
      [createSourceObservation(availableInput({ uncertainty: ["partial extraction"] }))],
      DEFAULT_LIVENESS_POLICY,
      ASSESSED_AT
    ).confidence).toBe("medium");
    expect(assessSourceLiveness(
      [observation("2026-07-14T10:10:00.000Z", "available", 200)],
      DEFAULT_LIVENESS_POLICY,
      ASSESSED_AT
    ).state).toBe("unresolved");
    expect(assessSourceLiveness(
      [observation("2026-07-13T20:00:00.000Z", "not-found", 404)],
      DEFAULT_LIVENESS_POLICY,
      ASSESSED_AT
    ).state).toBe("stale");

    const sourceA = observation("2026-07-14T09:59:00.000Z", "available", 200);
    const sourceB = createSourceObservation(availableInput({ sourceKey: "greenhouse:job-43" }));
    expect(() => assessSourceLiveness([sourceA, sourceB], DEFAULT_LIVENESS_POLICY, ASSESSED_AT))
      .toThrow(/cannot mix source keys/);
  });

  it("rejects invalid liveness policy and assessment clocks", () => {
    expect(() => assessSourceLiveness([], { ...DEFAULT_LIVENESS_POLICY, maxLiveAgeMs: -1 }, ASSESSED_AT))
      .toThrow(/maxLiveAgeMs/);
    expect(() => assessSourceLiveness([], { ...DEFAULT_LIVENESS_POLICY, closedConfirmationCount: 0 }, ASSESSED_AT))
      .toThrow(/closedConfirmationCount/);
    expect(() => assessSourceLiveness([], DEFAULT_LIVENESS_POLICY, new Date(Number.NaN)))
      .toThrow(/assessment time is invalid/);
  });
});
