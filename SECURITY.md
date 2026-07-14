# Security

Report security issues through [GitHub private vulnerability reporting](https://github.com/OnourImpram/vocation-os/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include the affected version, reproducible steps, expected impact, and the smallest safe proof of concept. Do not include real CVs, credentials, tokens, or third-party personal data.

## Release Blockers

Public release is blocked if any private artifact, credential, local database, raw upload, private profile, or unsupported automation bypass is found.

If a previous public repository contained secrets, rotate affected credentials and rewrite history before release.

## Automation Boundaries

VocationOS must not bypass CAPTCHA, anti bot systems, payment prompts, identity checks, or site terms. It must not fabricate credentials, licenses, publications, employers, or eligibility.
