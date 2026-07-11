# Governance

VocationOS is designed for individual career decision support. It is not designed for employer side candidate ranking, filtering, rejection, or hiring decisions. Employer or platform deployment requires a separate compliance review.

## Regulatory Boundary

The EU Artificial Intelligence Act identifies employment, worker management, and access to self employment as a high risk domain when systems are used for recruitment, selection, application analysis, filtering, or candidate evaluation. VocationOS excludes employer side use from the public scope.

Source: https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng

## Risk Management Alignment

The project maps controls to the NIST AI RMF functions: Govern, Map, Measure, and Manage.

Source: https://www.nist.gov/itl/ai-risk-management-framework

This mapping targets NIST AI RMF 1.0. Because NIST states that AI RMF 1.0 is being revised, this document should be reviewed before every major release.

Release validation notes are maintained in `docs/RELEASE_VALIDATION.md`. They record engineering evidence gates and do not constitute legal, clinical, financial, immigration, licensing, employment, or standards compliance certification.

## Runtime Governance

The deterministic Safety Kernel, not an LLM response, owns consequential action policy.

Worker generation, independent evaluation, human approval, execution, and completion verification are distinct phases.

Employer side ranking, candidate filtering, rejection, performance evaluation, and hiring decisions remain outside the public product scope.

Governance references were checked against the official EU AI Act, NIST AI RMF, and ISO/IEC 42001 pages on 2026-07-11. Major releases require a new source review.

## Management System Reference

ISO/IEC 42001 is a reference point for mature AI management systems. VocationOS does not claim certification.

Source: https://www.iso.org/standard/42001
