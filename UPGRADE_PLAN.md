# VocationOS v0.3 Upgrade Pack

Integration note: this supplied theory and advisory plan is now the foundation of the broader v0.3 decision intelligence release. The independent architecture, ATS provenance, submission proof lifecycle, remote egress controls, threat model, and release gates are documented in `docs/V0_3_IMPLEMENTATION_PLAN.md`.

Status: release candidate, fully implemented and verified against the repository ci chain on 2026-07-06.

## Executive Summary

VocationOS v0.2 shipped a rigorous decision safety substrate: evidence status ontology, R0 to R4 reversibility gates, high stakes certainty brakes, hash bound claim validation, and an append only ledger. Its two open gaps were named in the differentiation report itself. The theory layer was a list of names rather than working logic, and there was no model facing layer at all, so the intelligence that would make the substrate useful day to day lived outside the system and outside its guarantees.

This upgrade closes both gaps without weakening a single gate. The theory list becomes an operational registry of 28 cited lenses wired into modes and rubric dimensions. A decision difficulty intake classifier gives the system a theory grounded front door. A new `/skill-coach` mode turns the planned happenstance skill set into psychoeducational micro practices paired with acceptance and commitment processes. And an advisory layer brings model generated text inside the trust boundary under one rule: the model proposes, the gates dispose.

## Design Principles Preserved

1. Conditional automation, not more automation. Nothing in this pack can submit, approve, or verify anything.
2. Blocked by default. Advisory output is forced to R0 structurally, not by convention.
3. Offline first. The default advisory client is deterministic and networkless, so tests and ci stay reproducible. A remote client exists only behind explicit environment configuration.
4. Synthetic examples only. No real personal data enters the repository.
5. Guardrails are never weakened to make tests pass. All 14 evaluator cases and all pre existing tests pass unchanged.

## What Changed

### src/theory.ts, rewritten
Each theory is now a `TheoryLens` carrying core constructs, runtime decision questions, mode bindings, rubric dimension bindings, a reversibility note, high stakes flag relevance, and primary source citations with DOIs where they exist. Three lenses were added to the original 25: Acceptance and Commitment Processes (Hayes et al., 2006), Psychology of Working (Duffy et al., 2016), and Career Decision Difficulties (Gati et al., 1996). `validateTheoryRegistry` enforces registry integrity at test time, including citation completeness and DOI format. The Ethical Risk Formulation entry is explicitly labeled an engineering formulation rather than a vocational psychology theory, citing the NIST AI Risk Management Framework.

### src/theory-engine.ts, new
`lensesForMode` and `questionsForMode` surface theory lenses and deduplicated guiding questions per mode, with specialist high stakes questions always first. `classifyDecisionDifficulties` implements the Gati, Krausz, and Osipow taxonomy as the R0 front door, routing lack of readiness to `/skill-coach`, lack of information to evidence gathering modes, and inconsistent information to source triage and steelman review. `optionValueNote` states the economic rationale of each reversibility tag, making explicit why R4 never auto submits: irreversible commitment under uncertainty destroys option value. `composeTheoryBrief` bundles lenses, questions, rubric focus, and reversibility guidance for any mode.

### src/coach.ts, new
The `/skill-coach` mode operationalizes the five planned happenstance skills, curiosity, persistence, flexibility, optimism, and risk taking, as R0 micro practices, each paired with an acceptance and commitment process and a reflection prompt. Risk taking is deliberately framed as graded committed action across the R0 to R2 range, which is the reversibility taxonomy translated into skill language. `happenstanceReview` converts ledger history into reflection prompts and treats blocked actions as information rather than failure. When the clinical or mental health sensitivity flag is active, the plan attaches a referral note and the mode gate requires human review. A fixed disclaimer states that this is psychoeducation, not clinical assessment, diagnosis, or treatment.

### src/advisor.ts, new
Model generated text enters through a single choke point with structural guards rather than trust:

1. `buildAdvisoryPrompt` fences opportunity text between explicit untrusted content markers and states that fenced content is data, never instructions.
2. `sanitizeAdvisoryNote` forces `reversibilityTag` to R0 and `advisoryOnly` to true, filters theory ids to the registry, filters cited claim ids to the claim graph, withholds the text of any non publicly assertable claim from the narrative, truncates overlong narratives, and always appends the advisory disclaimer. Every forced or dropped field is reported in a sanitization record for audit.
3. The `AdvisoryNote` type shares no fields with the auto apply input, so a note cannot be smuggled into `decideAutoApply` even by accident.
4. Optional ledger recording writes advisory generation as an R0 `draft_generated` entry.

The default `OfflineTemplateClient` is deterministic and cites only claims listed as verified and public in the prompt. `createRemoteClientFromEnv` returns a client only when `ADVISOR_ENDPOINT`, `ADVISOR_API_KEY`, and `ADVISOR_MODEL` are all set, and the key is never logged.

### Schemas, CLI, tests, docs
`advisory-note` and `coaching-plan` schemas enforce the R0 and advisory only constants at the validation layer. `demo-skill-coach` prints a full coaching plan. `demo-advisory` runs both the honest offline client and a hostile fixture whose output claims R3 authority, cites a forged claim, and drops the disclaimer, then prints the sanitized result to prove the gate. Twenty seven new tests cover registry integrity, engine behavior, coach guards, and eight advisory red team cases. `docs/THEORY_MAP.md` is generated from the registry by `scripts/theory-map.ts` so the document can never drift from the code, and `scripts/citation-check.mjs` verifies every declared DOI against the Crossref registry before releases.

## New Safety Invariants

1. Advisory output is R0 by structure. Schema constants, sanitizer enforcement, and type separation all hold independently.
2. An advisory note can cite only claim ids that exist in the claim graph. Forged ids are dropped and reported.
3. Private claim text cannot leave through an advisory narrative.
4. Weak evidence still cannot become a precise public claim, and now model text cannot change evidence status either.
5. Psychoeducation halts at a named referral boundary when clinical sensitivity is flagged.
6. Every citation in the theory registry is checkable by machine, and registry integrity is a failing test, not a review comment.

## Research Bridge

The registry makes the system citable in academic work alongside the existing CITATION.cff. Three connections are now explicit in code rather than implied in prose. The R0 to R4 taxonomy is grounded in option value reasoning (Dixit & Pindyck, 1994) and doubles as an operationalization of calculated risk taking from planned happenstance theory (Mitchell, Levin, & Krumboltz, 1999; Krumboltz, 2009). The `/skill-coach` mode pairs those five skills with acceptance and commitment processes (Hayes et al., 2006), which supports psychoeducational research designs on career decision skills under uncertainty. The intake classifier implements the career decision difficulties taxonomy (Gati, Krausz, & Osipow, 1996), giving empirical studies a natural pre and post measurement anchor.

## Verification Evidence

All checks were run on this working tree on 2026-07-06.

| Check | Result |
| --- | --- |
| npm run typecheck (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes) | clean |
| npm run test | 13 files, 72 tests passed, 27 of them new |
| Evaluator | PASS, 14 of 14 |
| validate-schemas | all 10 schemas and example files valid |
| privacy scan, brand scan, narrative marker scan | passed |
| docs:check against README metrics | passed, modes 21, theories 28, schemas 10, cli commands 23 |
| Full ci chain including site build and pack check | passed |
| demo-advisory hostile fixture | forced to R0, forged claim and unknown theory dropped, disclaimer appended |

Citation verification status: the DOIs for Kruglanski et al. (2002), Greenhaus and Beutell (1985), and Oyserman and Destin (2010) were individually confirmed against Crossref records during authoring. The remaining DOIs are drawn from standard bibliographic records, book citations carry no DOI by nature, and `npm run citations:check` performs the full machine sweep against Crossref. Run it once with network access before tagging the release.

## Integration Guide

1. Create a branch, for example `feature/theory-engine-v0.3`.
2. Apply the patch file or copy the changed and new files listed in the manifest.
3. Run `npm ci && npm run ci` locally and confirm the same green results.
4. Run `npm run citations:check` with network access.
5. Review against CONTRIBUTING: the new mode ships with schema, tests, docs, and a high stakes assessment. Evaluator cases were intentionally left at 14 to keep release metrics stable, and adding advisory and coach evaluator cases is the first item proposed for v0.3 final.
6. Update the version field and tag when satisfied.

## Deliberately Out of Scope

Browser submission adapters remain roadmap items because they carry the highest misuse surface and deserve their own threat model. Network calls stay out of the ci chain. Employer side use remains excluded from scope per GOVERNANCE.md. Encrypted private state and signed bundles remain on the v1.0 track.

## Proposed Next Steps

For v0.3 final: evaluator cases for the advisory sanitizer and the coach referral guard, a terminal view for theory briefs, and score calibration fixtures that exercise theory informed rubric focus. For v0.4: a small validation study design for the `/skill-coach` prompts, optional human referral routes, and the signed bundle work.

## Task Checklist

- [x] Rewrite theory registry with constructs, questions, bindings, and citations
- [x] Add theory engine with mode lenses, difficulty intake, and option value rationale
- [x] Add `/skill-coach` mode with ACT paired practices and clinical referral guard
- [x] Add advisory layer with structural R0 enforcement and sanitization reporting
- [x] Add advisory-note and coaching-plan schemas and register them
- [x] Wire demo-skill-coach and demo-advisory CLI commands
- [x] Add 27 tests including 8 advisory red team cases
- [x] Generate THEORY_MAP.md from the registry
- [x] Add Crossref citation check script
- [x] Update README metrics and sections, changelog, and package scripts
- [x] Pass the full repository ci chain
- [ ] Run citations:check with network access before tagging
- [ ] Add evaluator cases for advisory and coach gates in v0.3 final
