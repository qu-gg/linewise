# OMP for VS Code

Private local alpha of a custom OMP harness. It uses public VS Code APIs and the official ACP SDK, not private Copilot internals. In the source checkout, see the [implementation plan](IMPLEMENTATION_PLAN.md) for current milestone status and the [feature and release inventory](TODO.md) for missing features, validation gaps and GitHub/release work. Project-owned code is [MIT licensed](LICENSE); bundled components retain their [third-party licenses and attribution](THIRD_PARTY_NOTICES.txt).

## Try It

Requirements: VS Code 1.146+, a trusted filesystem workspace, and **OMP 18.21.0** installed on the workspace host.

1. Run `omp` in a terminal on that host. Use `/login` and select GitHub Copilot if authentication is needed.
2. Install the generated `vs-omp-0.0.1.vsix` using **Extensions: Install from VSIX**.
3. Open a disposable workspace and run **OMP: Open Chat**. The view appears in the secondary sidebar.
4. Start a session or send a prompt. Set `omp.executablePath` if `omp` is not on the host's PATH.
5. Select a changed file to open its editor-tab diff. Keep retains the current content; Discard restores the first unresolved pre-agent buffer.

Keep/Discard is independent of Git. Multiple prompts accumulate against the same unresolved baseline. If the user or another process changes a pending file, Discard refuses to overwrite it. Keep resolves the record while retaining the live content.

## Supported Slice

- One active OMP process/session per window, with stored session selection and resume.
- Copilot model and thinking selectors, streamed responses, Stop and serialized queued follow-ups.
- Explicit selection/editor, multiple-file, open-resource and workspace-diagnostic snapshots, with inspection/removal and original-snapshot historical replay.
- Read-only, session-scoped Todos disclosure immediately above Changed Files in the composer dock, with provider ordering, status icons/counts and remembered collapse state.
- Independently collapsible turn activity, thinking, and tools; thinking auto-closes when the agent moves on, and final answers remain outside collapsed activity.
- Model output reveals a subtle timestamp/model footer at its bottom right on hover or keyboard focus, without a popup or layout shift. Touch devices show it directly. Metadata survives reloads and model switches; older responses retain explicit unknown values. User prompts are right-aligned, width-constrained bubbles, distinct from bordered code blocks. Per-block credits are not displayed.
- Compact joined composer/file-review dock, hunk/per-file/bulk Keep/Discard, operation history and terminal-style tool output with copy controls.
- Session Context popover with reported token usage/cost and a direct Compact Context action. Detailed inspection runs OMP's `/context`; compaction runs its advertised `/compact` command without consuming a pending editor attachment.
- Inline historical prompt editing with Cancel/Send, before-prompt and after-answer forks, recoverable original conversations, and per-session composer drafts.
- Canonical native history boundaries, private-file resume across process restarts, legacy filename recovery, and serialized prompt/history/configuration/review operations.
- Guarded UTF-8 text reads/writes, file creation, cumulative per-file review, and reload-persisted snapshots.
- Native hashline edits, explicit deletion and paired rename review, including edited moves and recoverable partial failures.
- Linux command-only shell execution with selectable command permissions, bounded output and prompt-owned process cleanup.
- Approve-once before outside-workspace operations, even when the file is already open in an editor.
- Native-style one-time command approvals in the scrolling conversation and outside-file approvals above the composer, with inline details/expansion, Allow Once and Skip.
- Existing CRLF preservation, unsaved-buffer baselines, symlink checks, and conflict detection.
- Local memory enabled by default; no MCP servers.
- Read-only storage inspection plus explicitly confirmed session export/deletion, retention plans and conservative orphan cleanup on the supported local Linux host.

**This is not the full planned MVP.** The explicit allowlist is `read`, `write`, `todo`, `retain`, `recall`, `memory_edit`, `edit`, and `bash`. Native `edit` uses captured pre/post images and the host journal; new files still use `write`. Delegation, LSP, unknown tools, archive/database writes, internal URL targets and executable-bit changes remain blocked. Binary, BOM, oversized and unsupported text targets are rejected. There are no terminal side-effect snapshots. Save participants can cause a review conflict rather than silently changing the recorded result.

Shell policy evaluates the actual executable, arguments, working directory and explicit environment. When confirmation is needed, the inline command card shows those values; Allow Once never saves a grant. Only the ordinary command route is enabled: service, async, PTY, custom-cwd and other extra shell arguments are refused, and native direnv/auto-background/async/service settings are pinned off. Commands run with host permissions, not in a sandbox. They can change unenumerated files or external state, and those effects are not covered by Keep/Discard or conversation rewind. Deliberately detached processes cannot be contained by process-group cleanup.

Command approvals appear within the scrolling conversation, outside collapsible activity, not inside the composer or under Changed Files. Outside-workspace file approvals remain docked after Queued Prompts, Todos and Changed Files, outside their shared scroller. Exact command details and full proposed file diffs remain read-only and scrollable; expansion stays inline. Host-owned opaque IDs bind consent to the current operation, and Stop, stale replies, reload or disposal cannot grant it. The command menu only opens the existing global-user rule settings. No folder/session/workspace/Always Allow grants, command editing, model-backed Explain or inspector/pop-out are added. The stronger Allow All elevation warning remains a native modal; Source Control guidance remains in command details.

## Review, Tasks and Context

Expand a file's changes to navigate, Keep or Discard an individual hunk. Keep advances the accepted baseline without rewriting the file; Discard reverses only the selected pending hunk. Stable opaque identities reject stale controls, including ambiguous identical hunks. Exact-image checks preserve newer user work; interrupted partial resolution is recovered from a durable intent. Creation, deletion, rename and conflicted records remain whole-operation review. Operation history records the turn and tool where known; ordinary ACP writes do not invent unavailable tool-call IDs.

Todos show the latest turn's structured plan immediately above Changed Files in the composer dock, in provider order, with pending/in-progress/completed states. They are read-only. Queued Prompts is a separate, matching disclosure above Todos: it contains future user prompts, not the agent's task plan. All three sections use compact headers and a shared scrolling stack above the fixed composer. Plan entries persist with the transcript; Todos and Queued Prompts collapse state is remembered per session. A new turn without a plan clears the active list rather than showing stale tasks. Historical plans remain in their activity.

Use **Add Context** for an explicit editor/selection, files, chosen open text resources or workspace problems. With no range selected, **Active Editor or Selection** captures the explicitly chosen whole editor, including unsaved text. Nothing automatically attaches unrelated tabs. Inspect a chip to open its immutable snapshot; remove it with its close button. Limits are eight snapshots, 64 KB UTF-8 per snapshot and 128 KB total. Problems include the first 200 workspace diagnostics, with an explicit count. Unsent snapshots are session-bound and transient; submitted snapshots persist with the turn and are reused by history edits/forks rather than rereading the editor.

OMP retains its own on-disk instruction discovery. Native acceptance proves workspace `AGENTS.md` reaches the provider under the production launch flags. Additional names use OMP's `contextFiles.extra` setting; this does not prove every upstream discovery source. Editor-only text still needs an explicit attachment.

During a running prompt, **Queue Follow-up** (or Enter) queues the draft separately from **Stop**. Up to five prompts/512 KB of serialized queue data are held in memory for the active session, including captured attachment snapshots. Prompts run FIFO only after the previous prompt's tool/history/storage cleanup finishes. Remove pending items individually or clear the queue. Failure pauses remaining items until **Resume Follow-ups**; Stop clears pending items. New/switch/reconnect, history changes, disconnect and shutdown clear the queue. It is not restored or automatically sent after reload. This is extension-owned serialization, not in-flight ACP steering or Autopilot.

Keyboard focus and text selections survive streaming renders; removed/disabled controls return focus to the composer. Stable live regions announce operation/task/queue/review/error changes, not every streamed token. Review, queue and attachment lists are bounded and scroll within short sidebars. Local browser acceptance covers dark/light/high-contrast themes and narrow/wide layouts; this is not exhaustive assistive-technology certification or full populated Copilot pixel parity.

## Command Permissions

Use the **Rules / Ask / Allow All** menu beside **Memory** in the bottom status bar while the session is idle. Stop an active turn before changing modes.

- **Command Rules** is the default. Supported literal read-only commands (`pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, constrained `rg`/`find`, and a small `git status` option set) can run automatically. Every part of a supported pipeline or chain must qualify. Other commands, including builds, tests and Blender, prompt unless a user rule permits them.
- **Ask Every Time** prompts for every command except an explicit deny, which blocks it.
- **Allow All Except Restrictions** requires a warning confirmation and permits unmatched ordinary commands. Explicit deny/ask rules and built-in sensitive-command prompts still apply. It resets on new sessions, session switches, forks, reconnects and window restarts, and can be revoked in the same menu.

Choose **Edit User Command Rules** to configure `omp.permissions.commandRules` in user settings. Only user-owned execution-host settings are read; workspace/folder overrides cannot grant approval. Copilot settings and OMP pattern rules are not imported.

```json
{
  "omp.permissions.defaultMode": "rules",
  "omp.permissions.useDefaultRules": true,
  "omp.permissions.commandRules": [
    { "command": ["npm", "test"], "action": "allow", "match": "exact" },
    { "command": ["git", "push"], "action": "ask" },
    { "command": ["git", "push", "--force"], "action": "deny" }
  ]
}
```

Rules match case-sensitive literal argument arrays, not substrings, regular expressions or shell globs. `prefix` is the default match; `exact` also requires the same argument count. Known `/bin` and `/usr/bin` executable paths normalize to their command name. Deny wins over ask, and ask wins over allow, regardless of rule order. Explicit allows can override built-in sensitive-command prompts, so prefer exact rules for commands that can execute other programs. Malformed rules disable execution until fixed. The built-in rules can be disabled through the user-only setting; this does not disable explicit restrictions or syntax checks.

Substitutions, redirections, globs, incomplete quotes, control characters, unsupported wrappers/shell forms and non-metadata environment overrides still require confirmation, even under Allow All or a matching allow rule. The supported OMP Bash wrappers include its actual `-l`, `-c`, command argument form. Sensitive defaults include deletion/permission/process/remote commands, `find` execution/write options, `rg` preprocessors and non-status Git commands. The policy is a convenience, not a security boundary: executable behavior, scripts, aliases/configuration and obfuscation are not sandboxed. A deny matches recognized command invocations, not every equivalent operation hidden in a program. Outside-workspace file-tool approval remains unchanged; shell commands are not confined by that file-tool boundary.

This follows the distinctions in [VS Code's approval documentation](https://code.visualstudio.com/docs/agents/run/approvals): terminal rules are separate from tool availability, and a negative approval rule means prompt rather than block. OMP also exposes allow/prompt/deny rules; this host policy uses those explicit outcomes with stricter argument matching instead of copying an upstream wildcard list. No full Autopilot continuation, automatic question answers, model judge or OS sandbox is enabled.

Native delete/move require exact preimages, clean source buffers and absent move destinations. A move has one paired review record and must be resolved before either path can be edited again. Multi-file calls are not atomic: completed or interrupted operations remain reviewable if a later operation fails. Discard refuses newer user/external content. See the [tool-expansion inventory](TODO.md).

Context figures come from ACP usage updates, normally after a model turn. Unreported values are not estimated. Following compaction or a model switch, the meter marks its previous figures as stale until a new usage update arrives. Detailed `/context` reports can include additional OMP-specific breakdowns. Compaction uses OMP's configured summarization behavior and can consume model requests; it refuses sessions that are too small. Both session commands are disabled during an active turn. Bulk Undo stops rather than overwriting a file with newer user/external changes.

History actions are **conversation-only**. Edit and Continue archives the original conversation, selects native history immediately before the edited prompt, and submits its replacement with the original attachment snapshot. Fork Before excludes that prompt and prefills it in the new session; Fork After includes the completed answer and paired tool history. Actions appear only for turns with verified native boundaries, so older unmapped turns remain read-only. Cancel does not contact the agent. Failed edit submissions retain their draft.

History operations leave files, unsaved buffers, pending review records, and review ownership unchanged. All sessions still share the current workspace and long-lived memory. In particular, recalled memory can contain facts from an abandoned branch: this is not complete forgetting or a machine-state checkpoint. Subsequent model-driven writes retain the normal approval/review safeguards. Native local checks prove generated populated-session compaction, summary-only future-context exclusion/retention, identical-prompt identities, interrupted turns and hook refusal. Nine deterministic interruptions and twelve real extension-host/OMP SIGKILL cases prove conservative reopening without automatic replacement replay, including an actual unsaved editor. Ambiguous transitions refuse continuation and retain the archived original.

The extension is configured to run on the workspace host in Remote-SSH, but **Remote-SSH has not been tested** and is deferred by request. Install/authenticate OMP separately there; local credentials and memory are never copied. Multi-root changes, other host platforms, power-loss durability and live Copilot screenshot parity remain validation work. The completed [local fault matrix](QUALITY.md#todo-4-fault-matrix) is not a claim about every possible combined failure.

## Storage and Data Flow

Prompts, explicitly selected editor/file/resource/diagnostic snapshots, approved file reads, and tool results go through OMP to the selected GitHub Copilot model using OMP's own login. OMP also loads its configured on-disk instructions. The extension does not obtain VS Code's Copilot tokens. There is no extension telemetry.

Session transcripts, archives, submitted attachment snapshots and before/after review snapshots live in private extension workspace storage on the execution host, with global-storage fallback when workspace storage is unavailable. The state file is written atomically with mode `0600`; its directory is created with `0700`. OMP session artifacts live beneath that directory. A guarded private command exchanges bounded history metadata through temporary `0600` files, without a model request or arbitrary session paths. Treat this storage as potentially sensitive source code; private modes are not encryption or a sandbox against other programs running as the same user.

Run **OMP: Inspect Storage** for a fresh read-only JSON report. It measures the current in-memory state's serialized UTF-8 bytes, session/turn counts, logical attachment text and all retained review-image text. Per-session metadata includes the last recorded turn activity, native-file references and protection reasons: active/running work, pending-review ownership, or an unfinished history transition and its recovery archive. Missing protected session references are reported, not classified as disposable orphans. Legacy attachment aliases are counted once logically, while serialized byte totals include their actual duplicate storage.

Inspection additionally measures regular native JSONL artifact bytes and ownership. It is not total disk usage: temporary exchange files, mutation envelopes, logs and OMP's separate memory database are not included. In-flight changes may not yet be committed. Reports omit transcript/snapshot bodies, but labels, filenames and the host storage path can still be sensitive. Inspection never deletes data or starts OMP.

Storage commands run only while the host is idle and never invoke inference:

- **OMP: Export Session** writes a new-only, private `0600` JSON file containing the selected transcript, submitted snapshots, review images and discoverable native history. It discloses sensitive contents before confirmation. This is inspection/export data, **not an importable or resumable backup**; `restoreSupported` is false. Existing destinations and symlinks are refused.
- **OMP: Delete Session** offers only unprotected sessions and confirms irreversible removal. State is committed before native artifacts are unlinked; shared/referenced artifacts remain. Active/running sessions, every review owner and both sides of unfinished recovery are protected. Stale selections and missing protected references refuse deletion.
- **OMP: Apply Retention Plan** proposes oldest eligible sessions after 30 inactive days or under state-size pressure. It requires confirmation, processes at most 128 sessions/artifacts per batch and does not run automatically. Unknown-age sessions require deliberate individual deletion. Archives and submitted snapshots share their owning session's lifetime; review/recovery data never expires while protected.
- **OMP: Clean Orphaned Storage** confirms up to 128 unreferenced native JSONL artifacts older than 30 days. It refuses ambiguous populated legacy ownership, missing protected references and unfinished recovery, and rechecks age, references and file identity. Reconnect legacy sessions to establish native mappings first. Unknown files, symlinks, directories, memory and workspace files are never swept.

The host-state growth budget is 64 MiB. Oversized legacy state may load and shrink but cannot grow further. Native sessions have a 32 MiB pre-prompt admission/export limit; an individual native operation can cross that threshold, so this is not an OS disk quota. Existing history is retained and another prompt is refused before provider dispatch. Exports are bounded to 128 MiB including escaped payloads; inventory scans stop at 4,096 directory entries. Protected or unknown-age data may keep usage above a planning target; it is never silently evicted. Unsent snapshots retain their existing eight-item/64 KB per-item/128 KB aggregate bounds, remain transient, and are cleared with their deleted owner. Remembered sidebar drafts are pruned from authoritative saved-session membership, including after reopening.

Persistence failures retain the previous committed state and allow explicit repaired retry. A later artifact-cleanup failure reports that session deletion already committed and leaves remaining artifacts for inspection and eligible orphan cleanup. Failed exports remove their partial new file when it is still the created file; no existing export is overwritten. Deletion is not secure erasure and does not remove independent exports, external backups, OMP memory or shell side effects. See the [storage and compatibility gates](QUALITY.md#todo-5-storage-and-retention) before changing these limits or widening support.

Supported existing `local`/`mnemopi` memory configuration is reused. An `off` backend is overridden only for extension-managed sessions with per-project Mnemopi, full-text-only retrieval, and `llmMode: none`. The default performs no remote memory-service calls or model-backed extraction. Existing supported backend settings can have their own OMP data flow. Remote memory backends are refused. User OMP configuration is not rewritten. OMP manages its memory files in its configured host-side storage, independently of the review journal.

## Develop

Development installation and tests require **Node 24.11+**, preferably Node 24 LTS (`nvm use`). See [Repository Quality Gates](QUALITY.md) for enforced limits, coverage debt, architecture contracts and baseline-review policy. The extension runtime is unchanged; the compiler can still execute under Node 18 against an already installed dependency tree, but the complete DOM-enabled test suite requires Node 24.11+.

```sh
npm ci
npm run check
npm test
npm run check:release
npm run spike:handshake
npm run spike:mutations
npm run package
```

Press F5 to launch the development extension, then open a test workspace in that window. `test:extension` uses the installed Linux VS Code executable; set `VSCODE_EXECUTABLE` for another location. It creates isolated user data/workspace directories and does not change the current window's settings or authentication. History tests load a local fixture provider into the actual OMP process and use an enabled disposable Mnemopi database; they do not make paid model requests. The fixture and test-only control API are unavailable in ordinary extension mode.

`npm test` currently runs 255 deterministic protocol, policy, review, state, history, host, workspace, terminal-backend and Webview checks. `npm run check` adds 18 quality-tool tests and metric/architecture gates. Production line coverage is 98.98%; all 14 TODO #5 metric exception entries are retired, with no raised limits or lowered floors. `check:native` and `check:release` require four raw-ACP terminal probes, nine integrated OMP/production-guard/host workbench approval and lifecycle cases, native permission-mode/rule acceptance, 15 actual native-parser cases, twelve hard-crash/reopen stages and the history/attachment/restart tests. Production-extension checks also cover read-only storage inspection, open/dirty-file mutations, partial CRLF review, multi-snapshot historical replay, workspace instruction discovery, queued/removed/stopped follow-ups, populated compaction failure/Stop, summary boundaries and native hook refusal. Deterministic checks add retention/export/cleanup and budget failures, legacy migration and scale probes, nine durable-state interruptions, six Stop phases, partial/failed atomic writes, config/memory I/O errors, combined Stop/save failures, credential redaction and real malformed/oversized/disconnected stdio. All fixtures use disposable local providers without paid inference.

The crash suite installs only a test companion in a fresh normal-workbench profile, blocks at a real production boundary, and lets an external controller SIGKILL the host and OMP without running cleanup. The renderer retains the dirty editor; recovery runs in a new extension-host process. `reports/history-crashes.json` records all twelve stages. This companion and its observers are excluded from the VSIX, and required gates cannot inherit a narrowed manual stage filter.

Native approval checks use dev-only `playwright-core` against the production Webview inside installed VS Code, without downloading a browser. A test-only companion extension runs in a separate disposable development window because VS Code suppresses the retained elevation dialog under its normal extension-test flag. Only that temporary window exposes a dynamic loopback debugging port; screenshots are saved under `reports/native-dialogs/`. The companion and automation are excluded from the VSIX. The tests preserve dirty buffers and pending review records and do not change this window's settings or run paid inference.

Native source checks copy the package-shaped production files into a temporary directory without workspace `node_modules`, so development dependencies cannot hide runtime resolution failures. `VS_OMP_VSIX=vs-omp-0.0.1.vsix npm run test:extension` instead checks an extracted private package using system `unzip`. No new VSIX has been generated for this checkpoint.

`OMP_SPIKE_PROMPT=1 npm run spike:handshake` makes a tiny real Copilot request. `spike:mutations` also uses the authenticated model and writes only disposable test targets. These commands consume model requests. `OMP_EXECUTABLE` selects another OMP binary for the mutation spike.

`OMP_SPIKE_CONTEXT=1 npm run spike:handshake` verifies that the installed OMP advertises and handles `/context` and `/compact` in a disposable empty session. The empty-session compaction refusal is expected.

`OMP_SPIKE_HISTORY=1 OMP_SPIKE_PROMPT=0 OMP_SPIKE_CONTEXT=0 node scripts/acp-spike.mjs` checks side-effect-free native history inspection, distinct fork identity, continued original access, historical navigation, excluded future conversation messages, and an unchanged protected file. It uses the local fixture provider with isolated enabled memory, without paid model requests. It does not test workspace rollback.

`OMP_SPIKE_TERMINALS=1 OMP_SPIKE_PROMPT=0 OMP_SPIKE_CONTEXT=0 node scripts/acp-spike.mjs` uses test-only terminal capability and the real backend in a disposable workspace. It checks host rejection, successful output/exit/release, ACP permission rejection, and Stop during pending approval with a harmless late allow. It uses no paid inference; production capabilities and guard policy are unchanged.

`OMP_SPIKE_TOOLS=1 OMP_SPIKE_PROMPT=0 OMP_SPIKE_CONTEXT=0 node scripts/acp-spike.mjs` exercises the installed native edit engine without paid inference: ranges, insertion, block editing, named/anonymous/persistent registers, multi-file edits, delete, edited/spaced rename, and stale/malformed/private-path refusals. Parser callbacks never mutate files; a private prompt-scoped broker submits captured changes to the host journal and waits for acknowledgement.

For UI-only inspection, run `node scripts/preview.mjs` and open `http://127.0.0.1:5174`. This fixture reuses the built production assets with mocked host messages; it does not run an agent. `PORT` selects another loopback port.

On Linux, packaging can use VS Code's bundled Node 24 when the shell's Node is older:

```sh
ELECTRON_RUN_AS_NODE=1 /usr/share/code/code node_modules/@vscode/vsce/vsce package --no-dependencies --no-rewrite-relative-links
```

The scoped `minimatch` override patches a separate packager advisory; the outstanding picomatch findings remain documented in [QUALITY.md](QUALITY.md#toolchain-assessment). VSIX packaging includes project and third-party licenses and omits development dependencies, tests, research fixtures, source maps, and the OMP executable.
