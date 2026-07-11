# Contributing

## Rules

1. Do not add real user data to tests, fixtures, docs, screenshots, or examples.
2. Do not weaken guardrails to make tests pass.
3. Every new mode needs schema, tests, docs, evaluator coverage, and high stakes assessment.
4. Every high stakes route needs a certainty gate.
5. Claim fabrication is not accepted.
6. Automation must preserve ToS boundaries, confirmation evidence, and human authorization.
7. Generators must not certify their own output.
8. New workers require capability manifests, tool allowlists, budgets, and stop conditions.
9. New adapters require provenance, liveness, privacy, and adversarial tests.
10. Safety policy changes require a dedicated review surface and cannot be hidden inside feature work.

Run this before opening a pull request:

```bash
npm run ci
```
