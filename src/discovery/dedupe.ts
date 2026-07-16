import { sha256, stableStringify } from "../hash.js";
import { providerManifestById, type DiscoveryProviderId } from "./providers.js";

export interface DedupeCandidate {
  readonly candidateId: string;
  readonly observationId: string;
  readonly providerId: DiscoveryProviderId;
  readonly sourceRecordId: string;
  readonly canonicalUrl: string;
  readonly applyUrl: string | null;
  readonly company: string;
  readonly companyDomain: string | null;
  readonly roleTitle: string;
  readonly location: string;
  readonly postedAt: string | null;
  readonly descriptionDigest: string | null;
  readonly taxonomyConceptIds?: readonly string[];
}

export interface TaxonomyAdjacencyResolver {
  adjacency(leftConceptIds: readonly string[], rightConceptIds: readonly string[]): number | null;
}

export interface DedupeOptions {
  readonly taxonomyAdjacency?: TaxonomyAdjacencyResolver;
  readonly minimumReviewAdjacency?: number;
}

export type DedupeOutcome = "merge" | "review" | "distinct";

export interface DedupeDecision {
  readonly leftCandidateId: string;
  readonly rightCandidateId: string;
  readonly outcome: DedupeOutcome;
  readonly reason:
    | "same-provider-record"
    | "same-application-endpoint"
    | "same-canonical-posting"
    | "same-content-provenance"
    | "provider-record-conflict"
    | "company-domain-conflict"
    | "cluster-identity-conflict"
    | "taxonomy-adjacent-role"
    | "identity-evidence-insufficient"
    | "material-identity-mismatch";
  readonly companyDomainMatch: boolean | null;
  readonly taxonomyAdjacency: number | null;
}

export interface DedupeCluster {
  readonly clusterId: string;
  readonly memberCandidateIds: readonly string[];
}

export interface DedupeResult {
  readonly schemaVersion: "1.0.0";
  readonly resultId: string;
  readonly clusters: readonly DedupeCluster[];
  readonly decisions: readonly DedupeDecision[];
}

interface NormalizedCandidate {
  readonly source: DedupeCandidate;
  readonly company: string;
  readonly roleTitle: string;
  readonly location: string;
  readonly companyDomain: string | null;
  readonly canonicalUrl: string;
  readonly applyUrl: string | null;
  readonly taxonomyConceptIds: readonly string[];
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TRACKING_PARAMETERS = new Set(["referrer", "lever-source"]);
const DEDUPE_OUTCOMES = ["merge", "review", "distinct"] as const;
const DEDUPE_REASONS: readonly DedupeDecision["reason"][] = [
  "same-provider-record",
  "same-application-endpoint",
  "same-canonical-posting",
  "same-content-provenance",
  "provider-record-conflict",
  "company-domain-conflict",
  "cluster-identity-conflict",
  "taxonomy-adjacent-role",
  "identity-evidence-insufficient",
  "material-identity-mismatch"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalIdentityUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name} must be credential-free HTTPS`);
  }
  if (url.hostname.endsWith(".")) throw new Error(`${name} must not use a trailing dot hostname`);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function canonicalCompanyDomain(value: string | null, candidateId: string): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error(`Dedupe companyDomain is invalid for ${candidateId}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Dedupe companyDomain is invalid for ${candidateId}`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    hostname.endsWith(".") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hostname)
  ) {
    throw new Error(`Dedupe companyDomain is invalid for ${candidateId}`);
  }
  return hostname;
}

function normalizeCandidate(candidate: DedupeCandidate): NormalizedCandidate {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(candidate.candidateId)) {
    throw new Error("Dedupe candidateId is invalid");
  }
  if (!/^OBS-[A-F0-9]{32}$/.test(candidate.observationId)) {
    throw new Error(`Dedupe observationId is invalid for ${candidate.candidateId}`);
  }
  if (!candidate.sourceRecordId.trim() || candidate.sourceRecordId.length > 512) {
    throw new Error(`Dedupe sourceRecordId is invalid for ${candidate.candidateId}`);
  }
  providerManifestById(candidate.providerId);
  const company = normalizeIdentityText(candidate.company);
  const roleTitle = normalizeIdentityText(candidate.roleTitle);
  const location = normalizeIdentityText(candidate.location);
  if (!company || !roleTitle) throw new Error(`Dedupe identity text is incomplete for ${candidate.candidateId}`);
  if (candidate.descriptionDigest !== null && !SHA256_PATTERN.test(candidate.descriptionDigest)) {
    throw new Error(`Dedupe description digest is invalid for ${candidate.candidateId}`);
  }
  if (candidate.postedAt !== null) {
    const parsed = Date.parse(candidate.postedAt);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate.postedAt) {
      throw new Error(`Dedupe postedAt is invalid for ${candidate.candidateId}`);
    }
  }
  const taxonomyConceptIds = [...new Set((candidate.taxonomyConceptIds ?? []).map((conceptId) => conceptId.trim()))]
    .filter(Boolean)
    .sort(compareText);
  if (taxonomyConceptIds.some((conceptId) => conceptId.length > 512 || /[\0]/.test(conceptId))) {
    throw new Error(`Dedupe taxonomy concept ID is invalid for ${candidate.candidateId}`);
  }
  return {
    source: candidate,
    company,
    roleTitle,
    location,
    companyDomain: canonicalCompanyDomain(candidate.companyDomain, candidate.candidateId),
    canonicalUrl: canonicalIdentityUrl(candidate.canonicalUrl, "canonicalUrl"),
    applyUrl: candidate.applyUrl === null ? null : canonicalIdentityUrl(candidate.applyUrl, "applyUrl"),
    taxonomyConceptIds: Object.freeze(taxonomyConceptIds)
  };
}

function decision(
  left: NormalizedCandidate,
  right: NormalizedCandidate,
  outcome: DedupeOutcome,
  reason: DedupeDecision["reason"],
  taxonomyAdjacency: number | null
): DedupeDecision {
  const ids = [left.source.candidateId, right.source.candidateId].sort(compareText);
  return Object.freeze({
    leftCandidateId: ids[0]!,
    rightCandidateId: ids[1]!,
    outcome,
    reason,
    companyDomainMatch: left.companyDomain === null || right.companyDomain === null
      ? null
      : left.companyDomain === right.companyDomain,
    taxonomyAdjacency
  });
}

function adjacencyFor(
  left: NormalizedCandidate,
  right: NormalizedCandidate,
  options: DedupeOptions
): number | null {
  if (!options.taxonomyAdjacency || left.taxonomyConceptIds.length === 0 || right.taxonomyConceptIds.length === 0) {
    return null;
  }
  const score = options.taxonomyAdjacency.adjacency(left.taxonomyConceptIds, right.taxonomyConceptIds);
  if (score === null) return null;
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("Taxonomy adjacency must be null or between zero and one");
  return Number(score.toFixed(4));
}

export function evaluateDedupePair(
  leftCandidate: DedupeCandidate,
  rightCandidate: DedupeCandidate,
  options: DedupeOptions = {}
): DedupeDecision {
  const left = normalizeCandidate(leftCandidate);
  const right = normalizeCandidate(rightCandidate);
  const minimumReviewAdjacency = options.minimumReviewAdjacency ?? 0.5;
  if (!Number.isFinite(minimumReviewAdjacency) || minimumReviewAdjacency < 0 || minimumReviewAdjacency > 1) {
    throw new Error("minimumReviewAdjacency must be between zero and one");
  }
  const taxonomyAdjacency = adjacencyFor(left, right, options);
  if (left.source.candidateId === right.source.candidateId) {
    throw new Error("A dedupe candidate cannot be compared with itself");
  }

  const domainConflict =
    left.companyDomain !== null &&
    right.companyDomain !== null &&
    left.companyDomain !== right.companyDomain;
  if (domainConflict) {
    return decision(left, right, "distinct", "company-domain-conflict", taxonomyAdjacency);
  }
  const sameCompany = left.company === right.company || (
    left.companyDomain !== null && left.companyDomain === right.companyDomain
  );
  if (
    left.source.providerId === right.source.providerId &&
    left.source.sourceRecordId !== right.source.sourceRecordId
  ) {
    return decision(left, right, "distinct", "provider-record-conflict", taxonomyAdjacency);
  }
  if (
    left.source.providerId === right.source.providerId &&
    left.source.sourceRecordId === right.source.sourceRecordId
  ) {
    const locationConflict = left.location.length > 0 && right.location.length > 0 && left.location !== right.location;
    if (!sameCompany || left.roleTitle !== right.roleTitle || locationConflict) {
      return decision(left, right, "distinct", "material-identity-mismatch", taxonomyAdjacency);
    }
    return left.canonicalUrl === right.canonicalUrl
      ? decision(left, right, "merge", "same-provider-record", taxonomyAdjacency)
      : decision(left, right, "review", "identity-evidence-insufficient", taxonomyAdjacency);
  }

  const sameTitle = left.roleTitle === right.roleTitle;
  if (!sameCompany) {
    return decision(left, right, "distinct", "material-identity-mismatch", taxonomyAdjacency);
  }
  if (!sameTitle) {
    return taxonomyAdjacency !== null && taxonomyAdjacency >= minimumReviewAdjacency
      ? decision(left, right, "review", "taxonomy-adjacent-role", taxonomyAdjacency)
      : decision(left, right, "distinct", "material-identity-mismatch", taxonomyAdjacency);
  }
  const sameLocation = left.location.length > 0 && left.location === right.location;
  const sameContentProvenance =
    left.source.descriptionDigest !== null &&
    left.source.descriptionDigest === right.source.descriptionDigest &&
    left.source.postedAt !== null &&
    left.source.postedAt === right.source.postedAt;
  if (
    left.applyUrl !== null &&
    left.applyUrl === right.applyUrl &&
    sameLocation &&
    (left.canonicalUrl === right.canonicalUrl || sameContentProvenance)
  ) {
    return decision(left, right, "merge", "same-application-endpoint", taxonomyAdjacency);
  }
  if (
    left.canonicalUrl === right.canonicalUrl &&
    sameLocation
  ) {
    return decision(left, right, "merge", "same-canonical-posting", taxonomyAdjacency);
  }
  if (
    sameContentProvenance &&
    sameLocation
  ) {
    return decision(left, right, "merge", "same-content-provenance", taxonomyAdjacency);
  }
  return decision(left, right, "review", "identity-evidence-insufficient", taxonomyAdjacency);
}

class DisjointSet {
  private readonly parents = new Map<string, string>();
  private readonly membersByRoot = new Map<string, Set<string>>();

  public constructor(ids: readonly string[]) {
    ids.forEach((id) => {
      this.parents.set(id, id);
      this.membersByRoot.set(id, new Set([id]));
    });
  }

  public find(id: string): string {
    const parent = this.parents.get(id);
    if (!parent) throw new Error(`Unknown dedupe candidate: ${id}`);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parents.set(id, root);
    return root;
  }

  public union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareText);
    this.parents.set(second!, first!);
    const firstMembers = this.membersByRoot.get(first!);
    const secondMembers = this.membersByRoot.get(second!);
    if (!firstMembers || !secondMembers) throw new Error("Dedupe cluster membership index is corrupt");
    for (const member of secondMembers) firstMembers.add(member);
    this.membersByRoot.delete(second!);
  }

  public members(id: string): readonly string[] {
    const root = this.find(id);
    const members = this.membersByRoot.get(root);
    if (!members) throw new Error(`Unknown dedupe cluster: ${root}`);
    return [...members].sort(compareText);
  }
}

function isHardIdentityConflict(decision: DedupeDecision): boolean {
  return decision.outcome === "distinct" && [
    "provider-record-conflict",
    "company-domain-conflict",
    "material-identity-mismatch"
  ].includes(decision.reason);
}

function clustersHaveHardIdentityConflict(
  sets: DisjointSet,
  candidatesById: ReadonlyMap<string, DedupeCandidate>,
  leftId: string,
  rightId: string,
  options: DedupeOptions
): boolean {
  if (sets.find(leftId) === sets.find(rightId)) return false;
  for (const leftMemberId of sets.members(leftId)) {
    const left = candidatesById.get(leftMemberId);
    if (!left) throw new Error(`Missing dedupe candidate: ${leftMemberId}`);
    for (const rightMemberId of sets.members(rightId)) {
      const right = candidatesById.get(rightMemberId);
      if (!right) throw new Error(`Missing dedupe candidate: ${rightMemberId}`);
      if (isHardIdentityConflict(evaluateDedupePair(left, right, options))) return true;
    }
  }
  return false;
}

export function deduplicateCandidates(
  candidates: readonly DedupeCandidate[],
  options: DedupeOptions = {}
): DedupeResult {
  const sorted = [...candidates].sort((left, right) => compareText(left.candidateId, right.candidateId));
  const candidateIds = sorted.map((candidate) => candidate.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error("Dedupe candidate IDs must be unique");
  sorted.forEach(normalizeCandidate);

  const sets = new DisjointSet(candidateIds);
  const candidatesById = new Map(sorted.map((candidate) => [candidate.candidateId, candidate]));
  const decisions: DedupeDecision[] = [];
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      let pairDecision = evaluateDedupePair(sorted[leftIndex]!, sorted[rightIndex]!, options);
      if (
        pairDecision.outcome === "merge" &&
        clustersHaveHardIdentityConflict(
          sets,
          candidatesById,
          pairDecision.leftCandidateId,
          pairDecision.rightCandidateId,
          options
        )
      ) {
        pairDecision = Object.freeze({
          ...pairDecision,
          outcome: "distinct" as const,
          reason: "cluster-identity-conflict" as const
        });
      }
      decisions.push(pairDecision);
      if (pairDecision.outcome === "merge") {
        sets.union(pairDecision.leftCandidateId, pairDecision.rightCandidateId);
      }
    }
  }

  const membersByRoot = new Map<string, string[]>();
  for (const candidateId of candidateIds) {
    const root = sets.find(candidateId);
    const members = membersByRoot.get(root) ?? [];
    members.push(candidateId);
    membersByRoot.set(root, members);
  }
  const clusters = [...membersByRoot.values()]
    .map((members): DedupeCluster => {
      members.sort(compareText);
      const digest = sha256(stableStringify(members)).slice("sha256:".length, "sha256:".length + 32).toUpperCase();
      return Object.freeze({
        clusterId: `DUP-${digest}`,
        memberCandidateIds: Object.freeze([...members])
      });
    })
    .sort((left, right) => compareText(left.memberCandidateIds[0]!, right.memberCandidateIds[0]!));

  const core = {
    clusters: Object.freeze(clusters),
    decisions: Object.freeze(decisions)
  };
  const digest = sha256(stableStringify(core)).slice("sha256:".length, "sha256:".length + 32).toUpperCase();
  return Object.freeze({
    schemaVersion: "1.0.0",
    resultId: `DEDUP-${digest}`,
    ...core
  });
}

export function assertDedupeResult(value: unknown): asserts value is DedupeResult {
  if (!isRecord(value)) throw new Error("Dedupe result must be an object");
  const expectedKeys = ["schemaVersion", "resultId", "clusters", "decisions"].sort(compareText);
  if (stableStringify(Object.keys(value).sort(compareText)) !== stableStringify(expectedKeys)) {
    throw new Error("Dedupe result envelope contains unexpected or missing fields");
  }
  if (value["schemaVersion"] !== "1.0.0" || typeof value["resultId"] !== "string") {
    throw new Error("Dedupe result envelope is invalid");
  }
  if (!Array.isArray(value["clusters"]) || !Array.isArray(value["decisions"])) {
    throw new Error("Dedupe result clusters and decisions must be arrays");
  }

  const clusters: DedupeCluster[] = [];
  const allCandidateIds: string[] = [];
  for (const rawCluster of value["clusters"]) {
    if (!isRecord(rawCluster)) throw new Error("Dedupe cluster must be an object");
    if (
      stableStringify(Object.keys(rawCluster).sort(compareText)) !==
      stableStringify(["clusterId", "memberCandidateIds"].sort(compareText))
    ) throw new Error("Dedupe cluster envelope is invalid");
    const members = rawCluster["memberCandidateIds"];
    if (
      typeof rawCluster["clusterId"] !== "string" ||
      !Array.isArray(members) ||
      members.length === 0 ||
      members.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(id)) ||
      new Set(members).size !== members.length
    ) throw new Error("Dedupe cluster identity is invalid");
    const sortedMembers = [...members].sort(compareText) as string[];
    if (stableStringify(members) !== stableStringify(sortedMembers)) {
      throw new Error("Dedupe cluster members are not in canonical order");
    }
    const digest = sha256(stableStringify(sortedMembers))
      .slice("sha256:".length, "sha256:".length + 32)
      .toUpperCase();
    if (rawCluster["clusterId"] !== `DUP-${digest}`) throw new Error("Dedupe cluster integrity check failed");
    allCandidateIds.push(...sortedMembers);
    clusters.push({ clusterId: rawCluster["clusterId"], memberCandidateIds: sortedMembers });
  }
  if (new Set(allCandidateIds).size !== allCandidateIds.length) {
    throw new Error("Dedupe candidate appears in more than one cluster");
  }
  const canonicalClusters = [...clusters].sort((left, right) =>
    compareText(left.memberCandidateIds[0]!, right.memberCandidateIds[0]!)
  );
  if (stableStringify(clusters) !== stableStringify(canonicalClusters)) {
    throw new Error("Dedupe clusters are not in canonical order");
  }

  const candidateIds = [...allCandidateIds].sort(compareText);
  const candidateIdSet = new Set(candidateIds);
  const decisions: DedupeDecision[] = [];
  const pairs = new Set<string>();
  for (const rawDecision of value["decisions"]) {
    if (!isRecord(rawDecision)) throw new Error("Dedupe decision must be an object");
    const decisionKeys = [
      "leftCandidateId",
      "rightCandidateId",
      "outcome",
      "reason",
      "companyDomainMatch",
      "taxonomyAdjacency"
    ].sort(compareText);
    if (stableStringify(Object.keys(rawDecision).sort(compareText)) !== stableStringify(decisionKeys)) {
      throw new Error("Dedupe decision envelope is invalid");
    }
    const left = rawDecision["leftCandidateId"];
    const right = rawDecision["rightCandidateId"];
    const outcome = rawDecision["outcome"];
    const reason = rawDecision["reason"];
    const domainMatch = rawDecision["companyDomainMatch"];
    const adjacency = rawDecision["taxonomyAdjacency"];
    if (
      typeof left !== "string" ||
      typeof right !== "string" ||
      compareText(left, right) >= 0 ||
      !candidateIdSet.has(left) ||
      !candidateIdSet.has(right)
    ) throw new Error("Dedupe decision candidate identity is invalid");
    if (!(DEDUPE_OUTCOMES as readonly unknown[]).includes(outcome)) throw new Error("Dedupe outcome is invalid");
    if (!(DEDUPE_REASONS as readonly unknown[]).includes(reason)) throw new Error("Dedupe reason is invalid");
    if (domainMatch !== null && typeof domainMatch !== "boolean") throw new Error("Dedupe company domain evidence is invalid");
    if (adjacency !== null && (typeof adjacency !== "number" || !Number.isFinite(adjacency) || adjacency < 0 || adjacency > 1)) {
      throw new Error("Dedupe taxonomy adjacency is invalid");
    }
    const mergeReasons: readonly DedupeDecision["reason"][] = [
      "same-provider-record",
      "same-application-endpoint",
      "same-canonical-posting",
      "same-content-provenance"
    ];
    const reviewReasons: readonly DedupeDecision["reason"][] = ["taxonomy-adjacent-role", "identity-evidence-insufficient"];
    if (
      (outcome === "merge" && !mergeReasons.includes(reason as DedupeDecision["reason"])) ||
      (outcome === "review" && !reviewReasons.includes(reason as DedupeDecision["reason"])) ||
      (outcome === "distinct" && (mergeReasons.includes(reason as DedupeDecision["reason"]) || reviewReasons.includes(reason as DedupeDecision["reason"])))
    ) throw new Error("Dedupe outcome and reason are inconsistent");
    if (outcome === "merge" && domainMatch === false) throw new Error("Dedupe merge contradicts company domain evidence");
    if (reason === "company-domain-conflict" && domainMatch !== false) {
      throw new Error("Dedupe company domain conflict lacks negative domain evidence");
    }
    if (reason === "taxonomy-adjacent-role" && adjacency === null) {
      throw new Error("Dedupe taxonomy adjacency review lacks adjacency evidence");
    }
    const pair = `${left}\0${right}`;
    if (pairs.has(pair)) throw new Error("Dedupe decision pair is duplicated");
    pairs.add(pair);
    decisions.push({
      leftCandidateId: left,
      rightCandidateId: right,
      outcome: outcome as DedupeOutcome,
      reason: reason as DedupeDecision["reason"],
      companyDomainMatch: domainMatch as boolean | null,
      taxonomyAdjacency: adjacency as number | null
    });
  }
  if (decisions.length !== candidateIds.length * (candidateIds.length - 1) / 2) {
    throw new Error("Dedupe result does not contain exactly one decision per candidate pair");
  }
  const canonicalDecisions = [...decisions].sort((left, right) =>
    compareText(left.leftCandidateId, right.leftCandidateId) ||
    compareText(left.rightCandidateId, right.rightCandidateId)
  );
  if (stableStringify(decisions) !== stableStringify(canonicalDecisions)) {
    throw new Error("Dedupe decisions are not in canonical order");
  }
  const reconstructedSets = new DisjointSet(candidateIds);
  for (const decision of decisions) {
    if (decision.outcome === "merge") {
      reconstructedSets.union(decision.leftCandidateId, decision.rightCandidateId);
    }
  }
  const reconstructedMembers = new Map<string, string[]>();
  for (const candidateId of candidateIds) {
    const root = reconstructedSets.find(candidateId);
    const members = reconstructedMembers.get(root) ?? [];
    members.push(candidateId);
    reconstructedMembers.set(root, members);
  }
  const reconstructedClusters = [...reconstructedMembers.values()]
    .map((members): DedupeCluster => {
      members.sort(compareText);
      const digest = sha256(stableStringify(members))
        .slice("sha256:".length, "sha256:".length + 32)
        .toUpperCase();
      return { clusterId: `DUP-${digest}`, memberCandidateIds: members };
    })
    .sort((left, right) => compareText(left.memberCandidateIds[0]!, right.memberCandidateIds[0]!));
  if (stableStringify(clusters) !== stableStringify(reconstructedClusters)) {
    throw new Error("Dedupe cluster membership is not derivable from merge decisions");
  }
  const core = { clusters: value["clusters"], decisions: value["decisions"] };
  const digest = sha256(stableStringify(core)).slice("sha256:".length, "sha256:".length + 32).toUpperCase();
  if (value["resultId"] !== `DEDUP-${digest}`) throw new Error("Dedupe result integrity check failed");
}
