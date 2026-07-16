import { describe, expect, it } from "vitest";
import {
  OFFER_DIMENSIONS,
  analyzeOfferScenarios,
  planPermissionBoundedNetworkActions,
  type OfferAnalysisScenario,
  type OfferDimensionWeights,
  type PermissionBoundedContact
} from "../../src/intelligence/index.js";

const weights = Object.fromEntries(OFFER_DIMENSIONS.map((dimension) => [dimension, 1])) as OfferDimensionWeights;

function dimensions(score: number): OfferAnalysisScenario["dimensions"] {
  return OFFER_DIMENSIONS.map((dimension) => ({
    dimension,
    score,
    evidenceRefs: [`evidence://offer/dimension/${dimension}`]
  }));
}

function offer(
  scenarioId: string,
  amount: number,
  overrides: Partial<OfferAnalysisScenario> = {}
): OfferAnalysisScenario {
  return {
    scenarioId,
    values: [{
      itemId: `${scenarioId}-BASE`,
      kind: "base-compensation",
      effect: "income",
      certainty: "guaranteed",
      annualRange: [amount, amount],
      currency: "USD",
      evidenceRefs: [`offer://${scenarioId}/base`]
    }],
    dimensions: dimensions(75),
    hardGates: [],
    ...overrides
  };
}

describe("permission-bounded network and offer scenarios", () => {
  it("never discovers contacts and applies spacing to accepted plans in the same batch", () => {
    const contact: PermissionBoundedContact = {
      contactId: "CONTACT-001",
      permission: "explicit-opt-in",
      allowedChannels: ["email"],
      permissionEvidenceRefs: ["consent://contact/001"],
      recentTouches: [{
        touchId: "TOUCH-001",
        occurredAt: "2026-07-10T10:00:00.000Z",
        evidenceRefs: ["receipt://touch/001"]
      }]
    };
    const plan = planPermissionBoundedNetworkActions([contact], [
      {
        requestId: "REQUEST-TOO-SOON",
        contactId: contact.contactId,
        channel: "email",
        action: "share-update",
        plannedAt: "2026-07-14T10:00:00.000Z",
        evidenceRefs: ["operator://request/soon"]
      },
      {
        requestId: "REQUEST-PLANNED",
        contactId: contact.contactId,
        channel: "email",
        action: "request-advice",
        plannedAt: "2026-07-25T10:00:00.000Z",
        evidenceRefs: ["operator://request/planned"]
      },
      {
        requestId: "REQUEST-SAME-BATCH",
        contactId: contact.contactId,
        channel: "email",
        action: "share-update",
        plannedAt: "2026-07-26T10:00:00.000Z",
        evidenceRefs: ["operator://request/same-batch"]
      },
      {
        requestId: "REQUEST-UNKNOWN",
        contactId: "CONTACT-NOT-SUPPLIED",
        channel: "email",
        action: "request-introduction",
        plannedAt: "2026-07-25T10:00:00.000Z",
        evidenceRefs: ["operator://request/unknown"]
      }
    ], { windowDays: 90, maxTouchesPerWindow: 3, minimumSpacingDays: 10 });
    expect(plan.contactDiscovery).toBe("disabled");
    expect(plan.plannedRequestIds).toEqual(["REQUEST-PLANNED"]);
    expect(plan.dispositions.find((entry) => entry.requestId === "REQUEST-SAME-BATCH")?.reasonCodes).toContain("NETWORK_SPACING_REQUIRED");
    expect(plan.dispositions.find((entry) => entry.requestId === "REQUEST-UNKNOWN")?.reasonCodes).toEqual(["NETWORK_CONTACT_NOT_SUPPLIED"]);
  });

  it("keeps high-value offers gated when material terms are unresolved", () => {
    const evaluations = analyzeOfferScenarios([
      offer("OFFER-BOUNDED", 100_000, {
        values: [
          {
            itemId: "OFFER-BOUNDED-BASE",
            kind: "base-compensation",
            effect: "income",
            certainty: "guaranteed",
            annualRange: [100_000, 110_000],
            currency: "USD",
            evidenceRefs: ["offer://bounded/base"]
          },
          {
            itemId: "OFFER-BOUNDED-COST",
            kind: "recurring-cost",
            effect: "cost",
            certainty: "estimated",
            annualRange: [20_000, 30_000],
            currency: "USD",
            evidenceRefs: ["evidence://bounded/cost"]
          }
        ]
      }),
      offer("OFFER-GATED", 500_000, { hardGates: ["terms-unverified"] }),
      offer("OFFER-MIXED", 90_000, {
        values: [
          {
            itemId: "OFFER-MIXED-USD",
            kind: "base-compensation",
            effect: "income",
            certainty: "guaranteed",
            annualRange: [90_000, 90_000],
            currency: "USD",
            evidenceRefs: ["offer://mixed/usd"]
          },
          {
            itemId: "OFFER-MIXED-EUR",
            kind: "benefit",
            effect: "income",
            certainty: "estimated",
            annualRange: [5_000, 5_000],
            currency: "EUR",
            evidenceRefs: ["offer://mixed/eur"]
          }
        ]
      })
    ], weights);
    expect(evaluations.find((entry) => entry.scenarioId === "OFFER-BOUNDED")).toMatchObject({
      status: "scenario-only",
      guaranteedAnnualRange: [100_000, 110_000],
      modeledAnnualRange: [70_000, 90_000]
    });
    expect(evaluations.find((entry) => entry.scenarioId === "OFFER-GATED")).toMatchObject({
      status: "hard-gated",
      paretoEfficient: false
    });
    expect(evaluations.find((entry) => entry.scenarioId === "OFFER-MIXED")).toMatchObject({
      status: "hard-gated",
      currency: null,
      modeledAnnualRange: null,
      specialistQuestionCodes: ["currency-review"]
    });
    expect(evaluations.every((entry) => entry.assertions.some((assertion) => assertion.code === "OFFER_NOT_A_CERTAINTY"))).toBe(true);
  });
});
