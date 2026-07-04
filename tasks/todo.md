# VocationOS Implementation Checklist

- [x] Build clean public repo boundary.
- [x] Enforce privacy and brand scans.
- [x] Add strict TypeScript and schema validation.
- [x] Add claim graph, application packet, and action ledger.
- [x] Enforce high stakes, reversibility, and auto apply gates.
- [x] Add tests, CI, docs, and release packaging.
- [x] Add public release blocker upgrades for claim hash binding, packet hash validation, unique ledger ids, pack check, real state validation, risk signals, rate limit, and specialist questions.
- [x] Add VocationOS Decision Control Room Astro microsite, GitHub Pages workflow, and generated banner assets.

## Verification Notes

- 2026-07-04: `npm run safe:publish-check` passed.
- 2026-07-04: `npm pack --dry-run` produced a clean package surface with `dist/cli.js` and without `dist/src`, `dist/test`, `.vocationos`, or `node_modules`.
- 2026-07-04: direct old-name search returned zero matches outside dependencies.
- 2026-07-04: `node dist/cli.js doctor` passed from a temporary working directory.
- 2026-07-05: `npm run site:build` passed for the Astro microsite.
- 2026-07-05: Generated `assets/control-room-background.png`, `assets/vocationos-banner.png`, and `assets/social-preview.png`.
