# Lessons

## 2026-07-05

When external review text is shared in chat, treat it as implementation input unless the user explicitly says it exists on GitHub. Do not infer that it is already a public issue, PR comment, or review thread.

## 2026-07-10

On Windows with current Node versions, `execFileSync("npm.cmd", ...)` can fail with `EINVAL` even when the same npm command works in PowerShell. Repository scripts invoked through npm should execute `process.env.npm_execpath` with `process.execPath` so the same implementation works on Windows and Linux CI.

When terminating a known hung agent process, do not print full descendant command lines. MCP launch arguments can contain credentials. Verify ownership with process id, parent id, executable name, and a redacted command match, then terminate without echoing arguments.

After creating a remote commit through the Git Data API, do not use `git diff <remote> -- <worktree>` as a content equality check when the local index still reflects the old base. Compare local Git blob hashes against the remote recursive tree instead.
