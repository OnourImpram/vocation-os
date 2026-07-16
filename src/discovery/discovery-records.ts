import { createOpportunityRecord, type OpportunityRecord } from "../opportunity.js";
import type { DiscoveredProviderPosting } from "./provider-adapters.js";
import { assessSourceLiveness, type LivenessAssessment } from "./liveness.js";
import {
  createOpportunityTruthRecord,
  type OpportunityFieldTruthInput,
  type OpportunityTruthFieldName,
  type OpportunityTruthRecord,
  type OpportunityTruthRecencyPolicy
} from "./opportunity-truth.js";
import {
  createSourceObservation,
  type ObservedSourceField,
  type SourceObservation
} from "./source-observation.js";
import type { DedupeCandidate } from "./dedupe.js";

const DAY_MS = 86_400_000;

export interface DerivedDiscoveryPosting {
  readonly opportunity: OpportunityRecord;
  readonly observation: SourceObservation;
  readonly liveness: LivenessAssessment;
  readonly truth: OpportunityTruthRecord;
  readonly dedupeCandidate: DedupeCandidate;
}

function evidencePointer(posting: DiscoveredProviderPosting, field: string): string {
  return `$adapter.postings[sourceRecordId=${JSON.stringify(posting.sourceRecordId)}].${field}`;
}

function postingFields(posting: DiscoveredProviderPosting): readonly ObservedSourceField[] {
  return Object.freeze([
    { field: "sourceRecordId", value: posting.sourceRecordId, confidence: "high", evidencePointer: evidencePointer(posting, "sourceRecordId") },
    { field: "company", value: posting.company, confidence: "high", evidencePointer: evidencePointer(posting, "company") },
    { field: "roleTitle", value: posting.roleTitle, confidence: "high", evidencePointer: evidencePointer(posting, "roleTitle") },
    { field: "location", value: posting.location, confidence: "high", evidencePointer: evidencePointer(posting, "location") },
    { field: "applyUrl", value: posting.applyUrl, confidence: posting.applyUrl === null ? "low" : "high", evidencePointer: evidencePointer(posting, "applyUrl") },
    { field: "postedAt", value: posting.postedAt, confidence: posting.postedAt === null ? "low" : "high", evidencePointer: evidencePointer(posting, "postedAt") },
    { field: "deadline", value: posting.deadline, confidence: posting.deadline === null ? "low" : "high", evidencePointer: evidencePointer(posting, "deadline") }
  ]);
}

function recencyPolicy(field: OpportunityTruthFieldName): OpportunityTruthRecencyPolicy {
  const policyField = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return {
    policyId: `discovery.${policyField}.v1`,
    maxAgeMs: field === "deadline" ? DAY_MS : field === "licensing" ? 30 * DAY_MS : 7 * DAY_MS,
    maxFutureSkewMs: 5 * 60_000,
    onExpiry: "stale"
  };
}

function truthField(
  posting: DiscoveredProviderPosting,
  observation: SourceObservation,
  field: OpportunityTruthFieldName,
  state: OpportunityFieldTruthInput["state"],
  value: OpportunityFieldTruthInput["value"],
  pointer: string,
  rationale: string
): OpportunityFieldTruthInput {
  return {
    state,
    value,
    evidence: [{
      observationId: observation.observationId,
      pointer: evidencePointer(posting, pointer),
      observedAt: observation.observedAt
    }],
    observedAt: observation.observedAt,
    recencyPolicy: recencyPolicy(field),
    rationale
  };
}

function opportunityTruth(
  posting: DiscoveredProviderPosting,
  opportunity: OpportunityRecord,
  observation: SourceObservation
): OpportunityTruthRecord {
  const remoteKnown = opportunity.remotePolicy !== "unspecified";
  const locationKnown = opportunity.locationText.length > 0;
  const deadlineKnown = posting.deadline !== null;
  return createOpportunityTruthRecord({
    opportunityKey: opportunity.opportunityId,
    assessedAt: observation.observedAt,
    mandatoryFields: ["remoteConditions", "workAuthorization", "licensing", "location", "deadline"],
    fields: {
      salary: truthField(posting, observation, "salary", "unresolved", null, "descriptionText", "Compensation was not asserted by the provider contract."),
      remoteConditions: truthField(
        posting,
        observation,
        "remoteConditions",
        remoteKnown ? "inferred" : "unresolved",
        remoteKnown ? opportunity.remotePolicy : null,
        "location",
        remoteKnown
          ? "Remote conditions were inferred deterministically from the provider location text."
          : "Remote conditions are not explicit in the provider contract."
      ),
      workAuthorization: truthField(posting, observation, "workAuthorization", "unresolved", null, "descriptionText", "Work authorization requirements were not asserted by the provider contract."),
      licensing: truthField(posting, observation, "licensing", "unresolved", null, "descriptionText", "Licensing requirements require separate evidence review."),
      location: truthField(
        posting,
        observation,
        "location",
        locationKnown ? "observed" : "unresolved",
        locationKnown ? opportunity.locationText : null,
        "location",
        locationKnown ? "Location was observed in the provider contract." : "Location was not supplied by the provider contract."
      ),
      deadline: truthField(
        posting,
        observation,
        "deadline",
        deadlineKnown ? "observed" : "unresolved",
        posting.deadline,
        "deadline",
        deadlineKnown ? "Deadline was observed in the provider contract." : "Application deadline was not supplied by the provider contract."
      )
    }
  });
}

export function deriveDiscoveryPosting(
  posting: DiscoveredProviderPosting,
  endpointObservation: SourceObservation
): DerivedDiscoveryPosting {
  if (posting.providerId !== endpointObservation.providerId) {
    throw new Error("Posting provider does not match its endpoint observation");
  }
  if (posting.capturedAt !== endpointObservation.observedAt) {
    throw new Error("Posting capture time does not match its endpoint observation");
  }
  const applyRoutePresent = posting.applyUrl !== null;
  const observation = createSourceObservation({
    providerId: posting.providerId,
    providerManifestVersion: endpointObservation.providerManifestVersion,
    sourceKey: `${posting.providerId}:${posting.sourceRecordId}`,
    requestedUrl: endpointObservation.requestedUrl,
    finalUrl: endpointObservation.finalUrl,
    observedAt: endpointObservation.observedAt,
    availability: "available",
    httpStatus: endpointObservation.httpStatus,
    contentType: endpointObservation.contentType,
    bodyDigest: endpointObservation.bodyDigest,
    cacheState: endpointObservation.cacheState,
    redirectCount: endpointObservation.redirectCount,
    fields: postingFields(posting),
    uncertainty: applyRoutePresent
      ? ["Posting fields were normalized through a versioned provider adapter."]
      : ["application-endpoint-missing", "A valid application endpoint was not present in the provider contract."]
  });
  const opportunity = createOpportunityRecord({
    source: posting.providerId,
    sourceId: posting.sourceRecordId,
    sourceUrl: posting.sourceUrl,
    canonicalUrl: posting.canonicalUrl,
    applyUrl: posting.applyUrl,
    company: posting.company,
    roleTitle: posting.roleTitle,
    locationText: posting.location,
    descriptionText: posting.descriptionText,
    postedAt: posting.postedAt,
    capturedAt: posting.capturedAt,
    extractionConfidence: applyRoutePresent ? "high" : "medium",
    sourcePayload: posting
  });
  return Object.freeze({
    opportunity,
    observation,
    liveness: assessSourceLiveness([observation], undefined, new Date(observation.observedAt)),
    truth: opportunityTruth(posting, opportunity, observation),
    dedupeCandidate: {
      candidateId: opportunity.opportunityId,
      observationId: observation.observationId,
      providerId: posting.providerId,
      sourceRecordId: posting.sourceRecordId,
      canonicalUrl: opportunity.canonicalUrl,
      applyUrl: opportunity.applyUrl,
      company: opportunity.company,
      companyDomain: null,
      roleTitle: opportunity.roleTitle,
      location: opportunity.locationText,
      postedAt: opportunity.postedAt,
      descriptionDigest: opportunity.descriptionHash
    }
  });
}
