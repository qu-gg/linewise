# Agent Notes

## Runtime

This repository requires Node **24.11+**. Agent-owned shell commands in Linewise use the VS Code host runtime when `omp.shell.nodeRuntime` is `auto` and the workspace declares Node 24 through `.nvmrc`, `.node-version`, or `package.json` engines. Check with `node -v` before running quality gates.

If a command still runs an older Node, set `omp.shell.nodeRuntime` to `host` (machine scope) or run the host runtime explicitly:

```sh
ELECTRON_RUN_AS_NODE=1 "$LINEWISE_NODE" scripts/quality.mjs check
```

The setting affects agent command tools only; the user's integrated terminal is unchanged.

## Reading Ranges

Use a whole-file read for small files. If the `read` tool rejects a `path:line` selector, do not retry the same selector. Use a bounded shell fallback or the `editor` tool instead:

```sh
sed -n '3,173p' src/model-routes.ts
nl -ba src/model-routes.ts | sed -n '56,90p'
```

The `read` tool accepts local regular files and directories, not URLs or internal URIs.

## Review Recovery

If an edit reports `File has newer changes` or `Native edit preimage is stale`, read the current file once and retry. Linewise supersedes a stale pending change when disk content has returned to the review baseline; do not force an edit over unrelated user work.

For release-ready evidence, run **Linewise: Prepare Pull Request**. It requires a clean branch that is not behind `origin/main`, runs the repository `check`/`verify`/`test` script with the host runtime, and copies a verification-backed PR body without creating or pushing the pull request.
