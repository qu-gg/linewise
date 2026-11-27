# Using Linewise

Start with the [README setup](../README.md#try-it) on a disposable workspace. Use **Linewise: Open Chat**, configure `omp.executablePath` in user settings if needed, and select a model. Only one active OMP process/session runs per workbench window.

## Models And Providers

OMP owns provider configuration and credentials. Authenticate in OMP (`omp`, then `/login`) before starting Linewise, or reconnect after adding a provider; Linewise lists only the models OMP advertises and does not store credentials. The in-composer model picker groups models by provider, sorts providers by their available model count (fewest first), and searches model names and `provider/model` identifiers.

For a new chat on an OpenRouter model, a secondary **Route** picker lists the model's upstream providers from OpenRouter's public endpoint catalog and defaults to **Auto (OpenRouter)**. The request sends only the model identifier, has no credentials or user content, and uses no API key. Choosing a provider pins it when the first prompt starts a fresh OMP session; it cannot be changed after the chat has turns. OMP 18.21.0 records the base model, not the upstream route, in its session journal, so reopening or resuming the chat forgets the pin and returns to Auto routing; the Route picker is only for the live new chat. A transient catalog failure leaves Auto available and does not block the chat. The OpenRouter provider list is external, unauthenticated metadata, not an OMP or Linewise support guarantee.

Selecting a model makes it the active model and the default for new sessions in this workspace. Resumed sessions keep their stored model. Before any model has been selected, `omp.model` seeds the first session when set; otherwise OMP's configured default is used. If a remembered model is no longer advertised, the next new session falls back to OMP's current/default model. `omp.model` must exactly match an advertised `provider/model` selector. OMP still owns route execution and effort suffixes; the new-chat Route picker is the only upstream pin exposed in Linewise. Switching to a model from another provider sends subsequent prompts and conversation context to that provider; provider authentication and credentials remain managed by OMP. Switching a model does not change OMP role models (smol/slow/plan/compaction) or guarantee image/tool support. A listed model is not a Linewise provider-certification claim.

## Review

Changed Files shows cumulative unresolved file-tool changes, with counts and file/bulk Keep/Discard actions. Selecting a file opens the public readonly inline review editor: green additions, red deletions, floating hunk Keep/Undo. Keep advances only that accepted baseline; Undo restores the selected pending hunk while preserving accepted text and exact line endings. Creation/deletion/moves retain whole-operation review.

After all review resolves, an existing file returns to its ordinary editor; a deleted file's review closes. Busy/stale/conflicting/retired owners cannot mutate through the controls. If newer user or external changes cause a conflict, inspect the live file rather than trying to bypass the refusal.

Review is independent of Git, includes unsaved text baselines where supported, and does not restore shell/task/web effects. Historical prompt edits and forks change conversation history, not workspace state.

## Context And Conversations

**Add Context** explicitly captures editor/selection, multiple files, images, chosen open resources, or workspace problems. Paste a PNG, JPEG or WebP image directly into the composer to attach it as context; text from the same clipboard is inserted into the draft. Active-editor offers are suggestions, not automatic attachments. Inspect/remove chips before sending. Submitted snapshots persist with the turn and are reused by history replay rather than rereading changed files.

Text context is bounded to eight snapshots, 64 KiB per snapshot and 128 KiB total. Images may be chosen as regular host files or pasted from the clipboard, at most 512 KiB each and 1 MiB aggregate; model image support is required. Notebook output images use separate indexed inspection. Do not attach secrets or expect every provider to revisit unattached historical image pixels.

Todos is the agent's latest structured plan; Queued Prompts contains your future follow-ups. The queue runs serially only after cleanup, pauses on failure, and clears on Stop or ownership/history changes. It is transient, not restored after reload, and does not steer an already running model request.

Search and filter sessions grouped by recency (`Today`, `Yesterday`, `Last 7 days`, `Older`), with relative activity, pending-review line totals, and an optional Archived group. Wide panels (about 620 px or more) show the picker beside the conversation as a collapsible sidebar; narrower panels open it full-surface. Archive/Restore is reversible metadata, not deletion. Open does not implicitly resume an agent. Edit and Continue and before/after forks retain recoverable conversation originals, but leave files, pending review ownership, buffers, memory, and external effects unchanged.

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

Browser pages are explicitly owned Playwright sessions, not your existing browser profile/tabs. Independent consent governs launch/navigation/interactions; state may persist across completed prompts in the same owner. **Linewise: Close Owned Browser**, Stop, disconnect/failure, and ownership/history changes revoke pages. No browser is downloaded or attached through CDP by the model. If the pinned Chromium is unavailable, Linewise tries configured or common system Chromium/Chrome/Brave executables and reports an actionable error if none launch. **Linewise: Open in VS Code Browser** opens the current owned page URL in VS Code's integrated browser for inspection; it is a separate user-visible tab, not the agent-controlled page, and its cookies, navigation and state are not synchronized.

## Storage

**Linewise: Inspect Storage** reports bounded current state/native artifact ownership without reading out transcript bodies or starting OMP. Reports can still expose labels and host paths.

Export is sensitive, new-only, private, and not resumable. Delete Session, Apply Retention Plan, and Clean Orphaned Storage require confirmation and protect active/running/review/recovery owners. No automatic sweep or secure-erasure claim is made. Separate memory, exports/backups, and external effects are not removed.

Read [SECURITY.md](../SECURITY.md) and [tool contracts](tools.md) for data flow and unsupported routes.
