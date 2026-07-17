# Security

Report security issues through [GitHub private vulnerability reporting](https://github.com/OnourImpram/vocation-os/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include the affected version, reproducible steps, expected impact, and the smallest safe proof of concept. Do not include real CVs, credentials, tokens, or third-party personal data.

## Release Blockers

Public release is blocked if any private artifact, credential, local database, raw upload, private profile, or unsupported automation bypass is found.

If a previous public repository contained secrets, rotate affected credentials and rewrite history before release.

A successful CodeQL workflow does not by itself prove that the analysis produced zero findings. The final commit must have no open P0 or P1 code scanning alert before release. Any not-applicable classification requires a concrete reachability or platform-boundary proof and a recorded dismissal rationale.

Existing artifact export targets are opened once and verified through the same file descriptor. Path identity, regular-file status, metadata stability, size, and content hash must remain bound throughout recovery.

## Automation Boundaries

VocationOS must not bypass CAPTCHA, anti bot systems, payment prompts, identity checks, or site terms. It must not fabricate credentials, licenses, publications, employers, or eligibility.

## Native Dependency Boundary

Version 0.6 supports a Windows native artifact only. Tauri `2.11.5`, the latest stable release at the v0.6 release review, retains `glib 0.18.5` through its Linux GTK dependency graph. That package is affected by [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g). VocationOS does not publish a Linux native artifact while that graph remains unresolved.

The dependency review exception is limited to that advisory and is preceded by `native:dependency-boundary`. The gate proves that the reviewed package remains present only in Tauri's non-Windows graph, remains absent from `x86_64-pc-windows-msvc`, and still arrives through the reviewed Tauri version. Dependency drift, a Windows reachability path, or removal of the upstream package fails CI and requires the exception to be removed or reassessed.
