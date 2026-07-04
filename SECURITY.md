# Security

Report security issues privately to the maintainer.

## Release Blockers

Public release is blocked if any private artifact, credential, local database, raw upload, private profile, or unsupported automation bypass is found.

If a previous public repository contained secrets, rotate affected credentials and rewrite history before release.

## Automation Boundaries

VocationOS must not bypass CAPTCHA, anti bot systems, payment prompts, identity checks, or site terms. It must not fabricate credentials, licenses, publications, employers, or eligibility.
