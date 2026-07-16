# Company Portal Catalog

`catalog/v1/company-portals.json` is the version 1 public catalog. It contains only organizations whose career portal passed the current live verification run.

`catalog/v1/unresolved-company-portals.json` records candidates that timed out, rejected the bounded request, exceeded the response cap, failed career page detection, or did not expose sufficient organization identity evidence. These records do not contribute to the verified count.

`catalog/v1/verification-report.json` binds the exact attempted, verified, unresolved, and source pack counts to SHA 256 digests of both data files.

## Verification Contract

A verified portal must satisfy every condition below.

1. Every request and redirect uses HTTPS.
2. The final response has a 2xx status.
3. The request finishes within the recorded timeout and redirect limits.
4. The response body stays within the recorded byte limit.
5. The final page exposes a career surface through its ATS provider, URL path, title, or bounded page content.
6. Organization identity is established through continuity with the official organization domain or through organization specific evidence in the returned title or content.
7. The response body digest, final URL, identity evidence, career signal, status, and timestamp are persisted in provenance.

HTTP success without identity and career evidence is unresolved.

## Source Packs

The catalog uses ten primary source packs: artificial intelligence, clinical care, academic institutions, education, health and life sciences, product organizations, startups, fellowship and research funders, public institutions, and international institutions. Each organization belongs to one primary pack, so pack counts sum exactly to the verified total.

The product and startup discovery seed uses factual frontmatter from `remoteintech/remote-jobs` at revision `acffb49fd1ab2c05f249f7ca5b80709ffb6d0fc9`, under its ISC license. Vocation OS independently requests every resulting official career URL. No source prose is copied. Institutional candidates are seeded from their official organization sites.

## Validation

Run the deterministic offline check:

```powershell
node scripts/catalog-check.mjs
```

Run a nonmutating live refresh check against the current verified and unresolved sets:

```powershell
node scripts/catalog-verify.mjs
```

Use `--write` only when intentionally publishing a new verification run. Bootstrap from the pinned Remote In Tech checkout with `--bootstrap-remoteintech <path> --write`.
