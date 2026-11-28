# Agent Workflow

Linewise keeps agent-owned work inside the same review and command authority as the chat.

Linewise appends a small trusted baseline to every agent session, independent of workspace files. A repository `AGENTS.md`, `.omp/AGENTS.md`, or Copilot instruction file is appended after it, so the read fallback also works in a fresh repository with no agent file.

## Review Recovery

An external formatter, Git checkout, or editor save can change a file while a review is pending. If disk content returns to the review baseline, the next agent edit supersedes the stale pending record instead of blocking. **Discard** is a no-op when disk already matches the baseline; genuinely different user content still causes a conflict.

If an edit reports `File has newer changes` or `Native edit preimage is stale`, read the current file once and retry. Do not force an edit over unrelated user work.

The Changes list is an actionable projection: it shows only live, non-identical pending agent edits. Conflict snapshots remain in the journal for recovery, but stale or externally changed records do not appear as Keep/Undo rows.

## Agent Runtime

Agent-owned shell commands can use the Node runtime bundled with VS Code. `omp.shell.nodeRuntime` defaults to `auto`, which uses the host runtime when `.nvmrc`, `.node-version`, or `package.json` engines declares Node 20 or newer. `host` always uses it; `system` preserves the inherited `node`. Commands also receive `LINEWISE_NODE` and `LINEWISE_NODE_VERSION`. This setting does not change the user's integrated terminal.

The host runtime matters for project gates that require Node 24: `node`, `npm`, `npx`, jsdom, Playwright, and ESLint all resolve through the same `PATH` shim.

## Prepare Pull Request

**Linewise: Prepare Pull Request** requires a clean branch that is not behind `origin/main`. It runs the repository's `check`, `verify`, or `test` script with the host runtime, then opens a PR body containing the captured command, exit status, branch state, and changed files. The body is copied to the clipboard. The command does not create, push, or merge a pull request.

## Reading Ranges

Prefer a whole-file read for small files. If the `read` tool rejects a `path:line` selector, do not retry the same selector. Use a bounded shell fallback or the `editor` tool:

```sh
sed -n '3,173p' src/model-routes.ts
nl -ba src/model-routes.ts | sed -n '56,90p'
```

The `read` tool accepts local regular files and directories, not URLs or internal URIs.
