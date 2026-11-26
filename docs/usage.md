# Using Linewise

Start with the [README setup](../README.md#try-it) on a disposable workspace. Use **Linewise: Open Chat**, configure `omp.executablePath` in user settings if needed, and select a model. Only one active OMP process/session runs per workbench window.

## Models And Providers

OMP owns provider configuration and credentials. Authenticate in OMP (`omp`, then `/login`) before starting Linewise, or reconnect after adding a provider; Linewise lists only the models OMP advertises and does not store credentials. The native model picker groups models by provider, sorts providers by their available model count (fewest first), and searches model names and `provider/model` identifiers.

Selecting a model changes the active model for the current OMP session only. New sessions use `omp.model` when set, otherwise OMP's configured default; resumed sessions keep their stored model. `omp.model` must exactly match an advertised `provider/model` selector. Routing/effort suffixes and upstream pins (`@...`, `:...`) remain OMP-owned. Switching a model does not change provider authentication, OMP role models (smol/slow/plan/compaction), or guarantee image/tool support. A listed model is not a Linewise provider-certification claim.

## Review

Changed Files shows cumulative unresolved file-tool changes, with counts and file/bulk Keep/Discard actions. Selecting a file opens the public readonly inline review editor: green additions, red deletions, floating hunk Keep/Undo. Keep advances only that accepted baseline; Undo restores the selected pending hunk while preserving accepted text and exact line endings. Creation/deletion/moves retain whole-operation review.

After all review resolves, an existing file returns to its ordinary editor; a deleted file's review closes. Busy/stale/conflicting/retired owners cannot mutate through the controls. If newer user or external changes cause a conflict, inspect the live file rather than trying to bypass the refusal.

Review is independent of Git, includes unsaved text baselines where supported, and does not restore shell/task/web effects. Historical prompt edits and forks change conversation history, not workspace state.

## Context And Conversations

**Add Context** explicitly captures editor/selection, multiple files, images, chosen open resources, or workspace problems. Active-editor offers are suggestions, not automatic attachments. Inspect/remove chips before sending. Submitted snapshots persist with the turn and are reused by history replay rather than rereading changed files.

Text context is bounded to eight snapshots, 64 KiB per snapshot and 128 KiB total. PNG/JPEG/WebP images are explicit regular host files, at most 512 KiB each and 1 MiB aggregate; model image support is required. Notebook output images use separate indexed inspection. Do not attach secrets or expect every provider to revisit unattached historical image pixels.

Todos is the agent's latest structured plan; Queued Prompts contains your future follow-ups. The queue runs serially only after cleanup, pauses on failure, and clears on Stop or ownership/history changes. It is transient, not restored after reload, and does not steer an already running model request.

Search Recent/Archived sessions; Archive/Restore is reversible metadata, not deletion. Open does not implicitly resume an agent. Edit and Continue and before/after forks retain recoverable conversation originals, but leave files, pending review ownership, buffers, memory, and external effects unchanged.

Context usage/cost comes from provider updates, not estimates. Compaction can consume model requests and does not create a machine-state checkpoint. Old/unreported/stale values remain qualified. Memory is host-local by default and may retain facts from abandoned branches.

## Command Permissions

While idle, use the permission menu beside Memory:

- **Command Rules:** supported literal read-only commands can qualify automatically; others prompt unless an explicit user rule allows them.
- **Ask Every Time:** commands prompt except explicit denies, which block.
- **Allow All Except Restrictions:** separately confirmed connection-scoped elevation; explicit deny/ask and conservative sensitive/syntax prompts remain.
- **YOLO Commands:** separately confirmed elevation allowing general syntax and project operations. Recognizable user restrictions and a small static dangerous-command denylist remain, but obfuscation/scripts can evade matching. It is not a sandbox or a complete destruction detector.

Only Rules/Ask can be saved as defaults. Elevated modes reset on session/history/connection/window lifecycle and can be revoked. User execution-host settings own literal argv rules; workspace/folder settings and Copilot approvals cannot grant authority. Deny wins over ask, ask over allow. Prefer exact matches for programs that can execute other programs.

Command approval shows the actual executable/arguments/cwd/environment; Allow Once never saves a grant. Outside-workspace file approval, URL/redirect consent, and browser consent are independent. Stop cancels owned work, but does not undo effects. Approval/execution waits have no default timeout; explicit positive execution timeouts start after consent.

## Owned Terminals And Browsers

Pipe/PTY commands support prompt-owned run/start/output/wait/stop. Preview services are not persistent workspace services. Human Take Over enables input only after permanently withholding future model-visible capture for that execution. Type secrets directly in that terminal. Resume Agent and actual process completion jointly release the hold; previous captured output and scrollback are not erased.

Browser pages are explicitly owned Playwright sessions, not your existing browser profile/tabs. Independent consent governs launch/navigation/interactions; state may persist across completed prompts in the same owner. **Linewise: Close Owned Browser**, Stop, disconnect/failure, and ownership/history changes revoke pages. No browser is downloaded or attached through CDP by the model.

## Storage

**Linewise: Inspect Storage** reports bounded current state/native artifact ownership without reading out transcript bodies or starting OMP. Reports can still expose labels and host paths.

Export is sensitive, new-only, private, and not resumable. Delete Session, Apply Retention Plan, and Clean Orphaned Storage require confirmation and protect active/running/review/recovery owners. No automatic sweep or secure-erasure claim is made. Separate memory, exports/backups, and external effects are not removed.

Read [SECURITY.md](../SECURITY.md) and [tool contracts](tools.md) for data flow and unsupported routes.
