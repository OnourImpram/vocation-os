# Privacy

The public repository must not contain real personal profile data, CV files, private PDFs, local databases, pasted content, upload artifacts, tool outputs, tokens, or secrets.

`npm run privacy:scan` checks tracked files and repository files for risky paths and credential patterns.

Synthetic examples are stored under `examples/demo-profile/`. Real data belongs only in ignored local state.
