import type { OpportunityRecord } from "./opportunity.js";

export type TaxonomySource = "onet" | "esco" | "local";

export interface OccupationConcept {
  conceptId: string;
  source: TaxonomySource;
  sourceVersion: string;
  label: string;
  language: string;
  skillIds: string[];
}

export interface OpportunityConceptLink {
  opportunityId: string;
  conceptId: string;
  titleSimilarity: number;
  matchedSkillIds: string[];
  provenance: {
    source: TaxonomySource;
    sourceVersion: string;
  };
}

export interface OpportunityGraph {
  generatedAt: string;
  opportunities: OpportunityRecord[];
  concepts: OccupationConcept[];
  links: OpportunityConceptLink[];
}

function tokens(value: string): Set<string> {
  return new Set(
    value.normalize("NFKD").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1)
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / union.size;
}

export function buildOpportunityGraph(
  opportunities: OpportunityRecord[],
  concepts: OccupationConcept[],
  now = new Date()
): OpportunityGraph {
  const opportunityIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const opportunity of opportunities) {
    if (opportunityIds.has(opportunity.opportunityId)) throw new Error(`Duplicate opportunity id: ${opportunity.opportunityId}`);
    if (fingerprints.has(opportunity.fingerprint)) throw new Error(`Duplicate opportunity fingerprint: ${opportunity.fingerprint}`);
    opportunityIds.add(opportunity.opportunityId);
    fingerprints.add(opportunity.fingerprint);
  }
  const conceptIds = new Set<string>();
  for (const concept of concepts) {
    if (conceptIds.has(concept.conceptId)) throw new Error(`Duplicate occupation concept: ${concept.conceptId}`);
    if (!concept.sourceVersion.trim()) throw new Error(`Taxonomy version is required for ${concept.conceptId}`);
    conceptIds.add(concept.conceptId);
  }

  const links: OpportunityConceptLink[] = [];
  for (const opportunity of opportunities) {
    const titleTokens = tokens(opportunity.roleTitle);
    const description = opportunity.descriptionText.toLowerCase();
    for (const concept of concepts) {
      const titleSimilarity = jaccard(titleTokens, tokens(concept.label));
      const matchedSkillIds = concept.skillIds.filter((skillId) => description.includes(skillId.toLowerCase()));
      if (titleSimilarity < 0.25 && matchedSkillIds.length === 0) continue;
      links.push({
        opportunityId: opportunity.opportunityId,
        conceptId: concept.conceptId,
        titleSimilarity: Number(titleSimilarity.toFixed(4)),
        matchedSkillIds,
        provenance: { source: concept.source, sourceVersion: concept.sourceVersion }
      });
    }
  }
  return { generatedAt: now.toISOString(), opportunities, concepts, links };
}

export function titleAdjacency(left: OccupationConcept, right: OccupationConcept): number {
  const leftSkills = new Set(left.skillIds);
  const rightSkills = new Set(right.skillIds);
  return Number(jaccard(leftSkills, rightSkills).toFixed(4));
}
