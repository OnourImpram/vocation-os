# Privacy

The public repository must not contain real personal profile data, CV files, private PDFs, local databases, pasted content, upload artifacts, tool outputs, tokens, passwords, or signing keys.

`npm run privacy:scan` checks tracked and untracked release files for risky paths and credential patterns.

Synthetic examples are stored under `examples/demo-profile/`. Real data belongs only in ignored local state.

## Local Store

The encrypted event store protects event and snapshot payloads with AES 256 GCM. Native runtime secrets use the OS credential store. The headless credential vault uses a masked master passphrase with `scrypt` and AES 256 GCM. Passphrases are not accepted through arguments, environment variables, shell fallbacks, or plaintext files.

Opaque aggregate identifiers, event types, timestamps, sequence numbers, and hashes remain operational metadata and are not encrypted.

Legacy import reports redact payload values and decoded state keys. They still expose deterministic hashes. Hashes are integrity bindings, not anonymization, and low entropy values may remain susceptible to local dictionary testing.

The headless credential vault and encrypted database normally share one runtime root. Whole directory rollback can replay both the database and its retained checkpoint digest. The native OS credential route provides a stronger separation boundary. External checkpoint archival remains roadmap work.

## Remote Advisory

Remote advisory is optional.

Remote egress requires an explicit approved classification, HTTPS, an allowlisted host, no redirects, response size limits, and a configured timeout. Private claims are withheld from advisory prompts.

No telemetry or remote data collection is enabled by default.

## Submission Proof

Submission proof stores redacted pointers, domains, bounded indicators, bounded opaque reference IDs, payload hashes, and collector signatures. Reference IDs reject URLs, email addresses, query strings, and unbounded text. Raw mailbox bodies, verification codes, query tokens, and full browser captures are not part of the proof schema.
