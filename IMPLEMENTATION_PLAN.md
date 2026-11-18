# OMP for VS Code: Implementation Plan

**Status:** Guarded private local alpha; full MVP incomplete  
**Prepared:** 2026-11-16  
**Last reconciled:** 2026-11-18  
**Repository target:** `qu-gg/vs-omp` (private; creation and push pending review)

## Current Checkpoint

This document records the target architecture and implementation progress. Sections describing intended capabilities are not a claim that those capabilities are enabled. The actionable gap inventory is [TODO.md](TODO.md); [README.md](README.md) describes the supported slice, and [QUALITY.md](QUALITY.md) defines the quality gates.

The local alpha runs OMP over ACP using public VS Code APIs, with model/thinking controls, streaming, cancellation, session persistence/resume, explicit multiple-context snapshots, local memory, and no MCP servers. Supported text mutations use cumulative persisted review with hunk/per-file/bulk Keep/Discard, operation provenance, dirty-buffer baselines, CRLF preservation, conflicts, and outside-workspace approval. The accepted UI includes collapsible activity/thinking/tools, separate final answers, a bounded joined dock with matching Queued Prompts, Todos and Changed Files disclosures above the composer, context controls, serialized queued follow-ups and semantic keyboard/live-region behavior.

Historical prompt editing and before/after forks are implemented against canonical native history, including archive recovery, populated-compaction boundaries, identical prompts, interrupted turns and reconnect cases. They are **conversation-only**: files, unsaved buffers, pending review records and ownership, shared memory, and external side effects are not restored. TODO #4's local validation is complete: nine deterministic interruptions and twelve actual extension-host/OMP hard-crash boundaries pass, preserving actual unsaved text/review ownership without replay. The finite phase/I/O/combined-failure matrix is recorded in [QUALITY.md](QUALITY.md#todo-4-fault-matrix), not inferred to cover other hosts or power loss.

TODO #5 now includes native JSONL inventory, private non-resumable export, confirmed protected session deletion/retention and conservative age-gated orphan cleanup. State/native/export/scan/batch budgets are explicit; protected and unknown-age data is never silently evicted. Queued persistence cannot resurrect removed sessions, post-commit artifact failures remain visible, and removed-session transient snapshots/drafts are pruned. All 14 kickoff metric exception entries are retired without weaker defaults or floors. Compatibility, legacy-state migration and 5,000-turn state/500-turn DOM smoke gates are documented in [QUALITY.md](QUALITY.md#todo-5-storage-and-retention). Toolchain assessment retains the fixture-pinned analyzer and exposes five unpatched development-only audit entries; production audit is clean, but the full audit/hosted CI is not cleared.

The explicit enabled tools are `read`, `write`, `todo`, `retain`, `recall`, `memory_edit`, `edit` and `bash`. Native text edits/deletes/moves use captured pre/post images and the host journal. Linux command-only shells independently evaluate actual command permissions: Ask Every Time, default Command Rules, or confirmed session-only Allow All Except Restrictions. User-only literal argument rules distinguish allow/ask/deny; uncertain syntax remains manual. Service/async/PTY/extra argument routes are refused. Delegation, LSP, special-target writes and executable-bit changes stay blocked. Remote-SSH remains unvalidated.

| Workstream                        | Current Status                                                                        | Remaining Gate                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Milestone 0: feasibility          | Local model/ACP/mediated-write proof delivered                                        | Remote placement and broader mutation-route assessment; unsupported routes stay disabled |
| Milestone 1: extension and ACP    | Core local alpha and supported local lifecycle/I/O matrix pass                        | Remote/cross-platform lifecycle and broader fresh-user onboarding                        |
| Milestone 2: workspace/Remote-SSH | Local adapter, explicit multi-context and Linux terminal capability implemented       | Real Remote-SSH and multi-root changes                                                   |
| Milestone 3: review               | Cumulative operation-aware/hunk review and protected confirmed retention implemented  | Broader host/filesystem fault matrices                                                   |
| Milestone 4: context/memory/UX    | Local tasks/context/queue, populated compaction and bounded keyboard/theme acceptance | Remote checks, fresh-user onboarding and broader assistive testing                       |
| Milestone 5: runtime manager      | Manual runtime path supported                                                         | Optional verified downloader not implemented                                             |
| Conversation history              | Local history/crash recovery and protected artifact retention implemented             | Remote/cross-platform validation and optional file restoration                           |
| Quality and distribution          | Local gates, zero metric exceptions and CI definition implemented                     | Upstream development audit fix; Git/remote, hosted CI/rulesets and release automation    |

The latest deterministic checkpoint has **255 application tests, 18 quality-tool tests, 98.98% production line coverage and zero metric exception entries**, with no raised limits or lowered floors. Architecture covers 122 modules with zero violations. Native acceptance includes read-only storage inspection, four raw-ACP terminal probes, nine integrated workbench/lifecycle cases, permission-mode/rule acceptance, 15 native-parser cases, real open/dirty-file mutations/history, partial CRLF review, immutable multi-context replay, instruction discovery, queued follow-ups, populated compaction failure/Stop, hook refusal and twelve hard-crash/reopen stages. Package-shaped isolated source acceptance passes without development dependencies. The release gate requires all these checks without paid inference; development audit exposure is not waived. TODO #3 remote testing is explicitly deferred by request.

The approved repository target is private `qu-gg/vs-omp`, with MIT licensing for project-owned code, preserved third-party notices, `main`, and a repository-local GitHub noreply identity. Preparation stops at manual review of the exact staged initial snapshot: no commit, repository creation or push is authorized in this step. The first hosted workflow may be red solely because of the explicitly documented upstream development audit findings; its audit step must not be bypassed. Native-host acceptance, repository protections and distribution remain separate gates. The existing VSIX predates this source checkpoint and must not be treated as its release artifact.

## 1. Goal

Build a local VS Code extension that runs the OhMyPi (OMP) agent with GitHub Copilot models and provides a focused coding-agent experience inside VS Code. The extension should make the active workspace, editor buffers, SSH-connected workspaces, OMP context files, and OMP memory useful to the agent. Its defining feature is inspectable, file-by-file and hunk-by-hunk review with Keep and Discard controls.

The intended result is a close functional and visual analogue of the current Local harness workflow, not an implementation of VS Code's private Local harness internals.

## 2. Feasibility Summary

| Capability                                                 | Feasibility                             | Boundary                                                                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OMP conversation and tool orchestration                    | High                                    | Run the installed OMP CLI as a child process over ACP.                                                                                                                                                          |
| GitHub Copilot models through OMP                          | Verified locally                        | Real model requests succeeded using OMP-managed auth, separate from VS Code's Copilot auth; other accounts/policies still need validation.                                                                      |
| Custom chat, output, tool activity, plans, and controls    | High                                    | A WebviewView can own the UI; it will not be the native Copilot Chat transcript.                                                                                                                                |
| Workspace and active-editor context                        | High                                    | The extension must explicitly supply editor-only context and implement ACP filesystem operations.                                                                                                               |
| Remote-SSH workspace                                       | Designed, not validated                 | Install/run the workspace extension and OMP on the SSH host with its own executable/auth. Support only the workspace opened in the current window, not a second OMP SSH target.                                 |
| OMP context files and local memory                         | High                                    | Prefer OMP's existing discovery and memory backends; memory behavior and privacy depend on the configured backend.                                                                                              |
| File-by-file diffs                                         | High                                    | ACP provides edit diff data and the extension can maintain a change journal.                                                                                                                                    |
| Hunk-level Keep/Discard                                    | Achievable, custom engineering          | ACP does not provide rollback. The extension must store snapshots, calculate/apply patches, and detect conflicts.                                                                                               |
| Review and sensitive-file approval for OMP file operations | Achievable, must verify mutation routes | Intercept supported ACP filesystem operations before mutation; require approve-once for targets outside every active workspace root. Disable or mediate any file-writing OMP tool that bypasses these handlers. |
| Shell execution and side effects                           | Verified command-only Linux slice       | Explicit command approval and prompt-owned lifecycle; side effects use Source Control, not extension-owned terminal snapshots or hunk review.                                                                   |
| Exact native Local/Copilot Chat integration                | Not a supported baseline                | Chat Participants are deprecated for new Copilot integrations; there is no documented public API to register this as a first-party harness or to inject changes into Local's private working set.               |

**Recommendation:** Prototype and ship a private local extension using OMP ACP and an extension-owned review UI. Treat the review journal as the primary product risk and test it before investing in visual polish.

The local prototype and first safety/quality pass have been delivered. Continue from the gaps in the current checkpoint rather than restarting the feasibility slice.

## 3. Findings and Environment Baseline

### Local environment checked

- VS Code: `1.146.0`.
- OMP: `18.21.0`, resolved from PATH or the explicit execution-host setting (local Linux acceptance).
- OMP configuration and authentication remain in its own execution-host storage, outside the repository.
- Remote-SSH is installed.
- The current `omp` binary is local to this machine. A Remote-SSH extension host will need an OMP executable on the remote machine as well.
- `omp models copilot --json` returned model entries under provider id `github-copilot`. This verifies the provider/catalog path, not account entitlement or successful model generation.
- `COPILOT_GITHUB_TOKEN` was not set in the inspected terminal environment. OMP may still have stored credentials; stored auth was not inspected.
- Subsequent disposable tests verified real authenticated `github-copilot/gpt-4.1` requests and mediated writes without inspecting or copying credential contents. The earlier catalog-only observation is not the current limit of model verification.

### Relevant product/API facts

- OMP exposes `omp acp`, a JSON-RPC Agent Client Protocol server over stdio. Its ACP documentation describes session creation/resume, model and thinking controls, plans, terminal support, filesystem bridging, permissions, and streamed tool updates.
- OMP emits ACP `diff` content for edit results that include old/new text. This is useful review input, but it does not mean the edit is pending or undoable.
- OMP routes supported reads/writes through ACP filesystem methods when the client advertises those capabilities. The write is applied through the client and OMP reads back the result. ACP itself has no undo/rollback operation.
- OMP's ACP permission gate covers shell commands and destructive delete/move operations. Ordinary file writes do not use that ACP-specific prompt, so the extension must enforce outside-workspace file approval itself before applying mediated writes. Verify all file mutation routes and disable or mediate any route that bypasses the extension.
- OMP's ACP mode accepts MCP servers supplied by the ACP client; it does not automatically load OMP's normal on-disk MCP configuration. VS Code's Copilot MCP configuration is not automatically exposed to OMP either. Section 4.7 compares the options and sets the initial default to no MCP servers.
- OMP's TypeScript SDK requires Bun and is not a Node.js SDK. A Node-based VS Code extension should use the existing OMP executable over ACP rather than embedding the SDK in-process.
- VS Code's supported extension APIs can provide a WebviewView, workspace filesystem access, text-document edits, file watchers, and the built-in diff editor. The built-in Local working set is not a public extension API.
- VS Code Remote-SSH supports workspace extensions running on the remote extension host. Its child processes run on that host; the Webview renders in the client UI and communicates through messages. The first release targets only the workspace opened in that VS Code window.
- Current VS Code guidance deprecates Chat Participants for new Copilot integrations. Agent plugins, MCP, and extension tools extend the Copilot harness; they do not let an extension own the conversation loop or reproduce arbitrary chat response rendering.
- The Local harness is deprecated and documented for removal by February 2027. Do not make it the long-term extension integration target.

## 4. Architecture Decision

### 4.1 Agent runtime: OMP ACP child process

The extension host launches `omp acp` in the active workspace directory. ACP is preferred over embedding the OMP SDK because the extension runs in Node.js while the OMP SDK requires Bun. ACP is preferred over an OMP-specific RPC client for the first implementation because ACP is the standardized editor-facing protocol and includes editor filesystem, terminal, permission, and diff concepts.

The child process owns OMP's agent loop, model calls, session format, OMP settings, skills, rules, and OMP memory. The extension owns VS Code integration, the view, remote-resource mapping, and change review.

Run only one active OMP session/process per VS Code window. Support creating, switching, and resuming sessions without concurrent agent execution. Before switching, cancel or finish any active turn and close the current session connection; preserve session identifiers and pending review records. Switching must not implicitly Keep or Discard changes, and resuming must revalidate pending records against the current files.

### 4.2 UI: extension-owned WebviewView

Provide a WebviewView in the secondary sidebar by default, with file diffs opening in editor tabs. The view contains:

- Conversation transcript with Markdown, code, references, and streaming output.
- Collapsible tool-call activity with status, inputs, outputs, and paths.
- Plan/todo display and explicit approval prompts.
- Model, thinking level, session, and connection controls supported by the ACP peer.
- A changed-files list that accumulates unresolved changes across turns and opens each file's diff in an editor tab.
- Input composer with cancellation, follow-up, and steering behavior where supported. Pending review must not prevent further prompts.

Use VS Code theme CSS variables and accessibility conventions. Keep the Webview as a UI client only: all filesystem operations, child-process lifecycle, ACP handling, approvals, and patch application belong in the extension host. Use a restrictive Content Security Policy and validate every Webview message.

Match Copilot Chat's visual style and interaction hierarchy as closely as public Webview APIs permit. Visual fidelity is an implementation requirement, without promising pixel-identical rendering, private Local harness behavior, or native Chat history integration.

#### Transcript layers and visual reference

Use the user-supplied Copilot Chat screenshot from 2026-11-16 as the visual reference. It shows a compact turn-summary row above an indented activity region with a subtle vertical rail, interleaved progress text and compact tool rows, nested command previews, and a separate user-facing answer below the activity region.

- **Turn summary:** provide an expandable Running/Completed/Cancelled/Failed header with step count, elapsed time, and added/removed-line counters where supported by actual session/journal data. Collapsing it hides the activity region, not the final answer or review controls.
- **Progress and thinking layer:** group intermediate assistant commentary and available thinking/reasoning summaries inside the turn's collapsible activity region. Display only content actually exposed by OMP/ACP; if reasoning is unavailable, show observable progress without inventing a thinking transcript.
- **Tool layer:** render file reads, edits, commands, and other tools as compact icon-and-label rows in chronological order among progress updates. Let each row independently expand its inputs, command preview, output, and details. Use linked file references and monospace command snippets; do not print every tool payload as a full-height transcript message.
- **User-facing answer layer:** keep the final Markdown response outside the activity group, in normal foreground text with readable spacing. Its visibility must not depend on expanding thinking or commands.
- **Density and styling:** follow the reference's restrained spacing, muted activity text, small status icons, subtle indentation/rail, and lightweight inline file references. Inherit VS Code typography, theme colors, and Codicons; avoid decorative cards, oversized headings, and large tool-output blocks by default.
- **Disclosure behavior:** default completed activity and verbose tool output to a compact, collapsed presentation. Make running status visible even when details are collapsed. Preserve user-chosen expansion state while streaming and across Webview recreation; do not repeatedly reopen sections or force-scroll users reading earlier content.
- **Attention and accessibility:** keep pending approvals and actionable failures visible even when activity is collapsed. Use keyboard-operable disclosure controls with accessible names and expanded state; status must not rely on color alone.

During implementation and iteration, consult relevant official VS Code UX/Webview documentation and compare the rendered sidebar directly with Copilot Chat or reference screenshots. Capture expanded and collapsed states at matching sidebar widths and themes, checking typography, spacing, hierarchy, command density, and scrolling behavior. Record unavoidable public-API or protocol differences rather than silently dropping the layered design.

#### Native-style approval rework (implemented, 2026-11-17)

**Delivered scope:** reproduce the installed workbench's compact confirmation styling inside the existing Webview. Routine command and outside-workspace file modals are replaced, not the permission policy. Per the user's placement correction, bash/command approvals belong within the scrolling conversation, outside collapsible activity, not inside the composer or beneath Changed Files. Outside-file approvals remain docked. Expansion stays inline: no editor inspector or pop-out. The first approval slice is implemented and release-verified; broader grants and the broader chat-style pass remain out of scope. The existing Queued Prompts -> Todos -> Changed Files ordering remains intact.

**Reference baseline:** the installed VS Code is `1.146.0`, built from commit `69047191fc427f2f92828279aae1d90d8eeda7ab` on 2026-11-10. Use the user's four approval screenshots as the visual target and the following revision-pinned implementation as the style/interaction reference, rather than a moving `main` branch:

- [Shared confirmation widget](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatConfirmationWidget.ts) and [confirmation CSS](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/media/chatConfirmationWidget.css): title, content, small primary/secondary buttons and split-menu construction.
- [Terminal confirmation renderer](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatTerminalToolConfirmationSubPart.ts): command preview, distinct explanation, Allow/Skip, scoped actions and retained elevation warning.
- [Docked approval carousel](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolConfirmationCarouselPart.ts) and [carousel CSS](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/media/chatToolConfirmationCarousel.css): composer-adjacent placement, close-as-Skip, bounded content and upward expansion.
- [Shared card CSS](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/chat/browser/widget/media/chatCard.css): shell, focus border and 22px header icon buttons.
- [Webview theme provider](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/webview/browser/themeing.ts): this build exports registered size tokens as well as color tokens and editor fonts to Webviews. Workbench-local CSS variables still need explicit fallbacks.

The [official approval guide](https://code.visualstudio.com/docs/agents/run/approvals), its [tool approval image](https://code.visualstudio.com/assets/docs/agents/approvals/chat-approve-tool.png), and the [Webview guide](https://code.visualstudio.com/api/extension-guides/webview) provide supporting references. The documented tool image was inspected; it shows the compact split Allow button, secondary Skip and scope menu. Available grants vary by tool and harness, so the image's menu is not an entitlement to implement every option. These workbench classes use private services; reproduce their presentation using public Webview APIs, not private imports or an assumption that the native widget is publicly exposed.

##### Visual and interaction scope

| Surface     | Agreed behavior                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Placement   | One visible pending request: bash/command approvals render within the scrolling conversation, outside collapsible activity, and scroll with the text. Outside-file approvals stay immediately above the composer after the existing dock sections, outside their scroller. Keep actions reachable and composer Stop usable; never duplicate a request in both locations. |
| Header      | Compact literal title such as `Run bash command?` or `Allow reading external file?`, with Codicons, a close/Skip control and an expand control when needed. Use the actual operation; never describe writes, deletes or renames as reads.                                                                                                                                |
| Command     | Selectable, read-only monospace preview derived from the exact executable/arguments. Keep host and cwd discoverable at a glance and a short `Not sandboxed` indication visible. Escape control/bidi characters; long or multiline commands remain fully inspectable, not authorized from an ellipsized summary alone.                                                    |
| File        | File/folder chip with disambiguating parent and full resolved target available. Show the operation and read/data-sharing notice or proposed diff; renames show both endpoints. A folder chip does not confer directory access. Do not invent a directory-enumeration tool or permission route to match a screenshot.                                                     |
| Explanation | Show concise intent only when supplied by the actual request or reliably correlated tool-call ID, clearly subordinate to the host snapshot. The current ACP terminal request has no explanation/goal field; do not guess from the last active tool or issue another model request to fill the gap.                                                                       |
| Decisions   | Primary `Allow Once` (or `Allow` with explicitly one-time scope), secondary `Skip`; header close rejects the same request. A split arrow appears only when supported actions exist. Initial terminal menu may open `Configure Command Rules...`; opening settings, viewing details or expanding never grants approval. File requests need no empty menu.                 |
| Details     | Follow VS Code's upward expansion for long content, preserving the decision row. Keep the full command, executable, argv, cwd, environment overrides and proposed file changes available as read-only inline details with bounded scrolling. No separate editor inspector or pop-out; expanding or collapsing does not approve or rerun anything.                        |
| Disclosure  | Move repetitive multi-paragraph shell warnings and Source Control guidance into accessible details/help. Retain the concise host/unsandboxed indication and the existing stronger confirmation for entering Allow All; routine visual parity must not silently remove elevation consent.                                                                                 |

The pinned carousel uses a collapsed maximum of `min(300px, 45vh)` and body limits of `min(200px, 30vh)`. A command-editor height above `min(150px, 25vh)` triggers availability of the expand control; that threshold is not itself a hard preview-height limit. Its expanded CSS uses `min(650px, 70vh)`; actual runtime sizing also respects available input height. Its header padding is `6px 10px 6px 12px`, header actions are 22px, and the decision row uses `4px 8px` padding with a 4px column gap. Treat these as measurable starting points, not fixed sizes that may obscure our composer in short windows.

Use the exported `--vscode-cornerRadius-*`, `--vscode-strokeThickness`, `--vscode-spacing-*`, registered font sizes/weights and `--vscode-editor-font-*` where available. Follow native `panel`, `input`, `chat.requestBorder`, `button`, `button.secondary*`, `menu`, `focusBorder`, `descriptionForeground` and toolbar-hover theme colors. Supply conservative fallbacks for variables not exported by the workbench, including chat-local font variables. Preserve light, dark and both high-contrast variants; do not hardcode the screenshot's dark palette. The native large-card radius is an existing-design-system reference, not a reason to round every panel.

**Expansion, not pop-out:** follow the source's screen icon by expanding the confirmation upward within the chat. Do not add an approval editor/diff inspector or separate window. The existing Changed Files diff-editor workflow is unaffected. Native command editing is also out of the first slice: changing text would require a new immutable request and fresh policy/path validation. The native `Explain` action starts a separate model-backed side chat; it is not a free details toggle and is not included here.

##### Host ownership and implementation boundary

The implemented entry points are [src/host-tools.ts](src/host-tools.ts) (`HostTools.approve`) and the signal-aware journal callback in [src/extension.ts](src/extension.ts). [src/approval-prompts.ts](src/approval-prompts.ts) builds exact presentation data, and [src/chat-view.ts](src/chat-view.ts) owns the public Webview lifecycle and approval adapter. [src/terminal.ts](src/terminal.ts) supplies the normalized command snapshot and abort signal. [media/composer.js](media/composer.js) owns the dock; [media/approvals.js](media/approvals.js), [media/main.js](media/main.js), [src/state.ts](src/state.ts) and the accessibility helpers own rendering, validated messages and focus behavior.

[src/approvals.ts](src/approvals.ts) provides the shared in-memory host-owned controller with at most eight FIFO entries and one visible request. Each pending request binds an opaque ID to the immutable operation, connection/session and operation/turn lifetime, with actual tool-call identity only when available. Its promise resolves once through a strict ID/decision message; the Webview never supplies replacement paths, commands or grant scope. Authorization payloads stay out of persisted transcript/display state, telemetry and automatic reload restoration.

Approval decisions, inline details and Stop must remain usable while the initiating prompt/file operation awaits approval. Do not put replies behind that operation or require `idleOperation`, and do not release the existing operation lock to make the UI work. Revalidate exact ownership, cancellation, workspace trust, cwd/path/preimages and current deny rules after the await and immediately before execution/mutation, retaining the existing journal and terminal checks.

Skip, close, cancellation, disconnect, session retirement, unexpected runtime exit, view disposal and reload must fail closed and settle pending requests without a hung operation. Merely hiding a still-live view is not approval; either retain the same host-owned request until it is visible again or cancel it according to an explicit lifecycle rule. Duplicate/stale decisions cannot approve the next request. If supported tools can request approval concurrently, preserve independent IDs and a bounded host queue rather than overwriting a request or introducing bulk approval by accident.

##### Visual parity versus new permissions

The first slice retains the existing command decision engine and global-user-only rule ownership, plus one-time outside-workspace file approvals. It must not import Copilot auto-approve settings, treat ACP routing permits as execution consent, weaken explicit deny/ask rules or imply sandboxing. Keep the existing session-only Allow All entry point and its warning, but do not add a shortcut that silently upgrades it into a new scope.

The screenshots' folder/repository grants, session command-prefix/exact grants, workspace grants and persistent `Always Allow` menu entries are separate authorization work. They require explicit product approval, matching/revocation/lifetime design and their own tests before appearing as actionable choices. Our existing global prefix/exact rule editor can remain accessible without adding automatic rule-writing shortcuts. Directory-read cards likewise require a real supported directory-read request, not just styling a file's parent as a grant.

##### Delivery and acceptance

1. Implement only the host-owned one-time approval adapter and compact command/file variants. Preserve the existing review/terminal boundaries and corrected Todos/Changed Files dock ordering. Use a static fixture first for visual comparison without model calls or host side effects.
2. Verify allow, Skip, close, double/stale clicks, concurrent requests if supported, abort plus late Allow, trust/rule/path changes, disconnect/runtime exit, view disposal/reload and unavailable view. Assert no spawn/mutation on denial and exactly one execution on valid consent; reject any deadlock while the originating operation is busy.
3. Exercise keyboard-only navigation, named split controls, Escape closing an open menu/details first, no implicit approval on composer Enter, stable focus during streaming and a concise approval announcement without repeated token announcements. Keep a usable Stop control and do not trap focus as if this were a modal dialog.
4. Compare actual rendered screenshots at matching 280/320/440/720px widths, short/tall panes, configured editor fonts/zoom, dark/light and both high-contrast themes. Include long paths, multiline/control-character commands, menus near viewport edges, large diffs and maximum existing dock content. Verify exact theme-token availability in the real extension Webview, not only the browser fixture.
5. Run the existing focused host/terminal/Webview tests, native approval/lifecycle acceptance and unchanged quality/release gates. Add no metric exceptions or coverage reductions. Only then carry the same measured density, typography, file-chip, tool-row and menu treatment into a separate broader chat-style pass; do not claim whole-chat pixel parity from approval work alone.

**Verified first slice:** the full release gate passes 158 application and 18 quality-tool tests, 96.29% lines (5665/5883), 95 architecture modules/zero violations and all installed OMP/VS Code native checks. New approval controller, prompt builders, host adapter and Webview have 100% deterministic line floors; improved existing budgets were tightened without new debt. Native acceptance renders the production card with actual size tokens, retained elevation, Skip/menu/Allow/cancel-late and process cleanup, plus unchanged queue/history/review checks. Browser acceptance passed 128 maximum-content layouts across the specified widths/heights, four theme variants, two font sizes and both card sizes; host/notice/decisions/Stop stay visible. Long paths, full diffs, menu edges, streaming focus and screenshots were checked. Exhaustive workbench zoom and assistive-technology coverage remain open. No new VSIX or whole-chat parity is claimed.

### 4.3 Workspace execution: workspace extension host

Declare the extension to prefer/run as a workspace extension. In a local window, the host and OMP run locally. In a Remote-SSH window, they run on the SSH host, next to the checkout. The Webview stays in the client UI and sends typed messages to the remote extension host.

Automatically choose the OMP working directory from the folders declared in the active VS Code window. In a single-folder window, use that folder directly. In a multi-root window, reuse a resumed session's root if it is still declared; otherwise prefer the active editor's containing workspace folder, falling back to the first declared folder. Keep the chosen root stable during the session rather than changing it when editor focus changes. All declared workspace roots remain in-workspace for access checks. If no folder is open, ask the user to open a workspace rather than falling back to a home directory or arbitrary process directory.

Resolve the OMP executable from an explicit extension setting first, then PATH. Never hard-code a developer's installation path. Display a clear preflight error if OMP is missing or incompatible. The private VSIX alpha should first support a user-installed executable. Then evaluate an opt-in runtime manager that downloads official per-platform builds into extension storage on the host where the extension runs. Pin versions and verify an upstream signature or checksum before execution; if release provenance cannot be verified, retain the manual-install path. Do not bundle an OMP executable into the VSIX by default.

### 4.4 Model access: OMP-managed Copilot provider

Use OMP's own `github-copilot` provider login and model selection. Do not scrape, copy, or depend on VS Code's internal Copilot token or private model APIs. The extension should check provider availability and report OMP's authentication/model errors without exposing tokens. Provide setup instructions for completing OMP's login in a terminal, then reconnecting the ACP session.

Whether a model can actually be used depends on GitHub account entitlement, organization policy, and the credentials configured for OMP. Verify a real, small model request during the initial spike.

### 4.5 Context and memory: OMP-native first

Let OMP discover its supported project/user instructions and context files, including `AGENTS.md`, `.github/copilot-instructions.md`, and its OMP-specific files. Add editor context that OMP cannot discover itself: active selection, open unsaved document text, diagnostics, and explicitly attached resources.

Do not create a second extension-owned memory system for the MVP. Enable OMP memory by default for every extension-managed session, including new and resumed sessions on local and Remote-SSH hosts. No separate disclosure, consent prompt, or opt-in step is required. Reuse an existing supported local OMP memory backend and scope; when none is configured, initialize per-project Mnemopi with full-text-only retrieval and `llmMode: none`. Verify that memory is active rather than relying on OMP's own defaults, and report setup failures rather than silently proceeding with memory disabled.

In Remote-SSH sessions, OMP's user-level configuration and memory are on the remote machine unless a separate, explicit bridge is designed. The extension should not silently copy local memory or credentials to a remote host.

The default Mnemopi preset stores and retrieves memory locally without model-backed extraction. Other supported local-storage configurations may send extraction text to the configured model provider; document this behavior without gating memory activation on a disclosure. Do not add a remote memory service or cross-machine memory bridge in the initial release. Hindsight and other remote memory services remain out of scope.

### 4.6 Sensitive files: outside-workspace approval

For this extension, the workspace is the set of roots in the active VS Code window. A resource outside every workspace root is sensitive, including a path under the user's home directory or a file that happens to be open in an editor tab but is not part of the workspace. In a multi-root workspace, a file under any declared root is in-workspace.

Before an extension-mediated OMP file operation creates, edits, deletes, moves, or renames a sensitive resource, the extension must pause and ask for explicit approval. Show the resolved URI/path, operation, and proposed diff or a useful summary. Offer approve-once and reject/cancel; do not persist an always-allow rule in the MVP. Rejecting or cancelling must leave the target unchanged. After approval, record the operation in the normal Keep/Discard journal.

Use URI-aware root checks, preserve remote authority, normalize paths, and revalidate the destination immediately before mutation. Where the filesystem provider supports it, resolve symlinks before deciding that a target is inside a workspace. Fail closed if the extension cannot establish the target's scope. Being open in an editor does not grant approval.

Out-of-workspace reads are a separate data-exposure boundary because file contents may be sent to Copilot. Do not let a model-generated path silently authorize such a read; require an explicit user attachment/selection or confirmation before sending the content to the model.

Every enabled OMP file-writing tool must pass through the ACP filesystem boundary or the private prompt-scoped host mutation broker. Disable routes that bypass those boundaries. Supported Linux shell commands independently evaluate the actual executable/argv/cwd/environment against user-owned host policy; explicit deny/ask rules survive Allow All. Their unenumerated file and external effects are not covered by per-file approval, review or rewind. This policy adds no OS sandbox or full Autopilot continuation.

### 4.7 MCP integration choices

MCP (Model Context Protocol) servers add tools or data sources to an agent. They are separate from OMP's model provider, OMP's built-in tools, project instruction files, and memory. In OMP ACP mode, the ACP client supplies the server list when creating/loading a session; OMP does not automatically load its usual on-disk MCP configuration. VS Code's Copilot MCP configuration is also not automatically available to this separate OMP process, and the extension must not assume it can enumerate or borrow Copilot's live MCP connections.

| Option                                      | Data flow and host                                                                                                                                                                        | Benefits                                                                    | Costs and limits                                                                                                                                                                                              | Recommendation                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| No MCP servers                              | OMP uses its built-in tools, skills, rules, and context. The extension sends editor context through ACP.                                                                                  | Smallest, easiest-to-review setup; no extra process or server credentials.  | Existing MCP-only tools are unavailable.                                                                                                                                                                      | MVP default.                                                                                                |
| Curated local stdio servers                 | The extension supplies an explicitly selected MCP server configuration to OMP at ACP session setup. The server process runs on the extension host; in Remote-SSH this means the SSH host. | Reuses existing local-process MCP servers without opening a network bridge. | The extension must choose a config source, translate it to ACP, manage process/environment secrets, and ask before launching untrusted commands. OMP's own MCP file is not automatically used in ACP.         | Best next step if specific servers are required. Start with an allowlisted server list and stdio transport. |
| HTTP MCP services                           | OMP connects to an explicitly configured HTTP MCP endpoint.                                                                                                                               | Useful for a server intentionally hosted as a service.                      | Requires network reachability, authentication, and a separate data-flow/trust review; it is not needed for the requested local-first setup.                                                                   | Defer; no network bridge in the initial release.                                                            |
| VS Code/Copilot MCP or extension-tool reuse | Attempt to reuse servers/tools already configured for VS Code Copilot or registered through VS Code's Copilot extension APIs.                                                             | Could reduce duplicate setup if an explicit supported bridge existed.       | Those integrations serve the Copilot harness and do not automatically become ACP server definitions or OMP tools. A proxy/adapter would be additional implementation and must bridge auth and host placement. | Do not assume reuse. Consider a dedicated adapter only for a named, required capability.                    |

**MCP decision for the first release:** pass an empty MCP-server list by default and rely on OMP's built-in capabilities. Keep the ACP client structured so a later version can pass explicitly configured stdio servers. Do not start arbitrary servers or copy secrets from another harness implicitly. The remaining user input is which named MCP servers, if any, are important enough to add later.

## 5. Component Design

### 5.1 Extension host services

1. **OMP process manager**
   - Resolve executable path, collect version, run at most one active OMP session/process per VS Code window, and set `cwd` to the automatically resolved workspace root.
   - Support session switching/resume without concurrent agent execution or implicit resolution of pending review.
   - Keep ACP stdout isolated from logs; route stderr to a named VS Code Output channel.
   - Handle startup timeout, process exit, cancellation, extension shutdown, and restart/reconnect without losing persisted session identifiers.
   - Never place credentials in command-line arguments, logs, Webview messages, or workspace files.

2. **ACP client**
   - Negotiate protocol version and capabilities before creating/resuming sessions.
   - Implement message framing, JSON-RPC request correlation, notifications, cancellation, and errors.
   - Implement session lifecycle and advertised modes/models; preserve unknown optional fields for forward compatibility.
   - Implement filesystem read/write and terminal methods only when the extension can honor their semantics.
   - Implement OMP's permission requests and fail closed on rejected, cancelled, or unsupported requests.
   - Keep a compatibility test against the OMP version present on each host.

3. **Workspace context service**
   - Map ACP absolute paths to workspace URIs without discarding URI scheme/authority.
   - Resolve the session root automatically from the open workspace using Section 4.3; retain that root for the session.
   - Start with local `file:` and Remote-SSH workspace files. Reject out-of-root writes unless the user explicitly approves them.
   - Read the live open document buffer when available, so unsaved editor changes are visible to OMP.
   - Apply writes through VS Code APIs so open buffers, encodings, line endings, and document events remain coherent.
   - Convert editor selections, diagnostics, and user-selected attachments into supported ACP content blocks.

4. **Review journal**
   - Persist OMP-originated change records in extension storage so a reload does not silently erase pending review.
   - Associate each record with session, turn/tool call, URI, operation, pre-image, post-image, timestamps/version metadata, and review state.
   - Accumulate unresolved changes across turns within a session. Coalesce successive agent writes to a file using the first unresolved pre-image and latest post-image, while retaining turn/tool metadata and preserving stale/conflict detection for intervening non-agent edits.
   - Keep resolved hunks out of later pending diffs by advancing their accepted baseline; retain unresolved hunks until the user explicitly Keeps or Discards them.
   - Mark entries stale when a user, formatter, or other process changes the file after the agent edit.

5. **Webview bridge**
   - Use versioned, schema-validated messages in both directions.
   - Send only display-ready session updates to the Webview; never treat Webview-supplied paths or approval decisions as trusted without host validation.
   - Restore visible state from extension/session storage after the Webview is recreated.

### 5.2 Review semantics

Match the Local working-set mental model: agent edits are already present on disk while pending; Keep clears pending state, and Discard restores or patches the file. Do not describe changes as staged or unsaved proposals.

Review is cumulative, not turn-scoped. Users may continue prompting without resolving the current changes. Agent-only follow-up writes extend the existing pending diff rather than resetting its baseline or marking it stale. Pending changes remain until explicitly Kept or Discarded and survive session switching/resume and extension reload; intervening user or external changes still trigger stale/conflict handling. Keeping a hunk advances only that hunk's accepted baseline, so a later agent edit to it becomes a new pending change without reviving previously accepted changes.

- Use ACP old/new text where available, supplemented by a pre-write snapshot captured in the extension host.
- Provide a per-file diff in a VS Code editor tab and a cumulative change list in the secondary sidebar.
- Implement extension-owned Keep/Discard controls. The built-in `vscode.diff` command displays differences but has no public hunk accept/reject API.
- For hunk-level Discard, apply a patch only if the expected post-image/context still matches. If it does not, preserve the current file and request conflict resolution rather than overwriting newer user changes.
- For whole-file Discard, restore the pre-image only if the current version still matches the agent's recorded post-image; otherwise enter a conflict state.
- Handle creates, deletes, and renames as explicit operations, not just text replacement.
- Keep a clear distinction between review state and Git staging/commits. Keep must not stage or commit changes.

### 5.3 Mutation coverage and honest limits

**Current supported slice:** ordinary UTF-8 writes/creation and native hashline edits/deletes/moves capture review pre/post images. Outside-workspace operations require explicit approval. Native callbacks never write files: a private prompt-scoped broker submits captured operations to the host journal and awaits acknowledgement. Exact preimages, path revalidation and dirty-buffer checks fail closed. Paired moves must be resolved before further edits to either path. Multi-file calls are sequential, not atomic; completed/interrupted operations remain in review when a later operation fails. Hunk review is still absent.

**Terminal and out-of-band changes:** the extension advertises Linux terminal capability with an injected prompt-owned backend. Command-level approval does not promise snapshots or a separate terminal mutation scope. Scripts, formatters, builds and external processes are outside the mediated-write journal and need Source Control/Git review; the inline approval details explicitly state this boundary.

### 5.4 Tool Expansion: Implementation and Acceptance Gates

**Section 1 completed 2026-11-17 for the bounded local Linux/text-only slice.** The backend is [src/terminal.ts](src/terminal.ts), SDK routing is [src/acp.ts](src/acp.ts), and prompt ownership/approval lives in [src/host-tools.ts](src/host-tools.ts). [src/native-edit.ts](src/native-edit.ts) uses the pinned native parser without filesystem ownership; [src/mutations.ts](src/mutations.ts) exchanges private scoped envelopes and exact one-use permits. The production CLI, guard, capability and permission policy enable only the eight documented tools. Unsupported requests remain denied.

| Component                  | Implementation Contract                                                                                                                                                                                                                                                             | Required Evidence Before Enablement                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal backend           | Exact-session opaque handles; explicit approval of immutable command/argv/cwd/env snapshots; canonical in-workspace cwd with revalidation; minimal inherited environment; no implicit shell; bounded requests/UTF-8 output/count; create/execution deadlines and idempotent cleanup | Real subprocess tests for rejection/late approval, cancellation, cwd retargeting/escape, invalid/large inputs, missing executable, environment isolation, ownership, byte limits, exit/signal status, TERM-resistant groups and remaining children after parent exit. Initial backend tests delivered; broader cleanup-failure and host/platform acceptance remain open. |
| Host permissions/lifecycle | Exact prompt/session/root/trust/abort ownership; command-specific approve-once; fail closed on stale grants and cleanup faults                                                                                                                                                      | Nine integrated OMP/production-guard/host workbench cases cover Skip, menu Escape/options dismissal, Allow Once, no remembered grant, late allow, running Stop, disconnect and unexpected OMP exit; dirty buffers/review ownership are unchanged.                                                                                                                        |
| OMP guard and shell UX     | Command-only Linux route; refuse service/async/PTY/cwd/extra arguments; disable direnv and native background/service paths                                                                                                                                                          | Four raw-ACP probes plus integrated workbench/lifecycle acceptance pass without paid inference. Terminal creation still independently approves actual argv/cwd/environment; a routing permit alone cannot spawn a process.                                                                                                                                               |
| Native `edit`              | Establish actual OMP edit routes and supported variants, then mediate through the text-file adapter/journal with captured pre/post images and approval revalidation                                                                                                                 | Real runtime route probes; repeated edits, dirty buffers/CRLF, stale content, selector/special-target rejection, symlink/approval races, cancellation and interrupted-save recovery. Keep disabled if any variant bypasses the journal.                                                                                                                                  |
| Delete                     | Add an explicit durable delete operation and existence/content/buffer preconditions, captured restoration image, outside approval, conflict refusal and recovery                                                                                                                    | Reject/cancel no-op, pending ownership, dirty/newer edits, approved delete/Keep/Discard, restart and failure between intent/mutation/persistence. Deleting a recorded agent-created file during Undo is not this capability.                                                                                                                                             |
| Move/rename                | Validate source and destination, collisions, both workspace scopes and pending ownership; represent paired images and recover partial operations without overwriting user work                                                                                                      | In-root/cross-root/outside cases, collisions, dirty/open files, symlinks, cancellation, newer edits, partial failure and reload, followed by Keep/Discard correctness. ACP permission alone cannot implement a journaled rename.                                                                                                                                         |
| Broader tools              | Delegation, LSP and special-target/executable mutations stay denied absent a separately reviewed mediation design                                                                                                                                                                   | Preserve negative allowlist/private-artifact/architecture tests; no blanket enablement based on shell/text-write success.                                                                                                                                                                                                                                                |

The initial backend is Linux-only and non-interactive, captures pipes rather than a PTY, and operates with the host account's permissions. It is not a sandbox: ordinary process-group cleanup does not contain a command that deliberately detaches or reverses its external effects. Defaults limit retained terminals to four, output to 64 KiB per terminal (requestable up to 1 MiB), aggregate request payload to 64 KiB, and create/execution phases to 120 seconds each (bounded configuration). Approval sees explicit environment overrides; only ordinary executable-path, home, user, locale, terminal and temporary-directory variables are inherited, not host credentials or private OMP environment.

Backend/protocol proof, host approval/lifecycle, installed-runtime acceptance and coordinated enablement are delivered. Native edit/delete/move have separate parser, journal, recovery and real-editor evidence rather than inheriting shell approval. Every slice meets existing coverage/metric/architecture gates without new debt or loosened limits. Historical edit/fork remains conversation-only.

`check:native` and `check:release` require raw-ACP terminal probes, nine integrated workbench/lifecycle cases, 15 actual native-parser cases and the production-extension suite. Parser cases cover ranges, insertion, block operations, named/anonymous/persistent registers, repeated/multi-file edits, delete, edited/spaced rename and stale/malformed/private refusal. Real editor cases cover open files, dirty-buffer refusal, review/Discard and existing conversation-history regressions. Source acceptance uses isolated package-shaped files without workspace dependencies. A public test-only companion/dev-only Playwright driver uses an isolated loopback CDP port because VS Code suppresses normal test dialogs; screenshots are under `reports/native-dialogs/`. This is not sandboxing, OS-native-dialog or Remote-SSH acceptance.

## 6. Milestones

### Milestone 0: Feasibility spike

**Current status:** local model, ACP, guarded-write and editor-baseline proofs delivered; Remote-SSH and broader disabled-tool assessment remain open. Not complete.

**Purpose:** prove the risky protocol and review assumptions before building the full UI.

- Confirm OMP's stored Copilot login state without exposing credential contents; if needed, complete the OMP GitHub device-flow login explicitly.
- Verify a small `github-copilot` model request from OMP and record the actual provider/model response.
- Launch `omp acp` from a test VS Code extension host and complete initialize, session creation, one prompt, cancellation, and clean shutdown.
- Test OMP file read/write, edit, create, delete, rename, shell command approval, and session resume against a disposable workspace.
- Determine exactly which file mutations use `fs/write_text_file`, which edits emit ACP diff blocks, and which actions mutate disk directly. Confirm that outside-workspace mutations cannot bypass the extension guard; disable any unsupported writer for the MVP.
- Test an outside-workspace target, including an already-open file, and verify approve-once permits the requested operation while reject/cancel leaves it unchanged.
- Check whether ACP terminal creation in a Remote-SSH window runs in the intended remote workspace.
- Start ACP with an empty MCP-server list and verify the built-in OMP workflow. Confirm that neither OMP's normal MCP file nor VS Code's Copilot MCP configuration is implicitly reused.

**Exit criteria:** model call works; remote process location is understood; file mutation routes and sensitive-file approval behavior are recorded; a minimal diff can be rendered from actual OMP output. Stop and revise the architecture if a supported file mutation can bypass the sensitive-file guard.

### Milestone 1: Extension shell and ACP client

**Current status:** core local alpha delivered with real stdio/native-host tests and the supported local lifecycle/I/O matrix complete. Remote/cross-platform lifecycle and broader fresh-user onboarding remain open.

- Scaffold a TypeScript VS Code extension targeting the chosen minimum VS Code API version.
- Add activation, extension settings for OMP executable and startup behavior, Output channel, workspace-host preference, and a preflight command.
- Implement the ACP process/client layer with protocol tests independent of model calls.
- Add session start/switch/resume/close with only one active session/process per window, streamed text, tool progress, cancellation, stderr reporting, and process cleanup.
- Add a minimal WebviewView in the secondary sidebar with the Section 4.2 transcript layers: collapsible turn activity, independently expandable tools, and a separate final answer. No review controls yet.

**Exit criteria:** repeatable local ACP session; no protocol/logging mix-ups; clean error messages for missing OMP, missing model auth, process exit, and unsupported protocol behavior.

### Milestone 2: Workspace and Remote-SSH integration

**Current status:** local text adapter, URI preservation, explicit editor/selection attachment and command-only Linux terminals implemented. Remote-SSH, richer context and multi-root lifecycle validation remain incomplete.

- Implement ACP filesystem and terminal capabilities using VS Code workspace/document APIs.
- Verify unsaved-buffer reads and updates to open documents.
- Resolve the working root automatically for single-folder and multi-root windows; keep it stable per session and handle missing or removed roots explicitly.
- Preserve remote URI context and validate root boundaries.
- Verify a Remote-SSH session uses the remote OMP binary, remote working directory, remote shell, and remote OMP config for the workspace opened in that VS Code window.
- Confirm no separate `omp ssh` target is started; remote access follows VS Code's active workspace connection.
- Add context attachments for active editor, selection, and diagnostics.
- Add a status indicator for OMP path/version and local versus remote execution host.

**Exit criteria:** the same representative file read/edit/test task works in local and Remote-SSH windows, with edits appearing in the correct editor buffers and files.

### Milestone 3: Change journal and review UX

**Current status:** cumulative text/create/delete/paired-move review, stable hunk resolution/navigation and accepted baselines, operation/turn/tool provenance, durable intent recovery, per-file/bulk resolution and conflict handling implemented. Create/delete/rename/conflict records resolve as whole operations. Confirmed retention and conservative artifact cleanup protect every unresolved review/recovery owner; silent automatic eviction is intentionally absent.

- Add file-change records for every supported ACP mutation.
- Add a cumulative changed-files list in the secondary sidebar, per-file diffs in editor tabs, line/hunk navigation, Keep, Discard hunk, Discard file, and Keep all/Discard all.
- Allow further prompts with unresolved changes, accumulating successive agent edits across turns until explicitly Kept or Discarded. Preserve accepted-hunk baselines when later edits occur.
- Implement conflict/stale handling for edits made after OMP's change.
- Cover create/delete/rename and repeated writes to one file.
- Ask for approve-once before applying any mediated file operation outside all active workspace roots; record approved changes in the normal review journal.
- Persist pending review state through Webview disposal, session switching/resume, and extension reload; revalidate records before offering rollback.
- Show a clear boundary and Source Control entry point for terminal/script/external changes outside the extension journal.

**Exit criteria:** deterministic tests prove that accepting keeps only selected changes and discarding restores only selected changes, without damaging pre-existing user edits or unrelated files. Tests also prove sensitive-file rejection/cancellation leaves the target unchanged.

### Milestone 4: Context, model, memory, and polish

**Current status:** local memory, selectors, context controls, read-only Todos immediately above Changed Files in the composer dock, multiple explicit context snapshots, transient serialized follow-ups in a matching Queued Prompts disclosure and bounded reference-driven keyboard/theme acceptance implemented. Production launch proves workspace `AGENTS.md` discovery and successful generated populated-session compaction; stable ACP steering is not exposed. Remote validation, broader assistive testing and fresh-user onboarding remain open.

- Add onboarding for OMP installation and OMP Copilot login; do not collect tokens in extension UI.
- Expose ACP model/thinking/mode controls with graceful handling when OMP or the account lacks a model.
- Validate OMP context-file discovery and surface setup/help affordances for `AGENTS.md`, project instructions, and OMP rules.
- Enable and verify OMP memory by default for all new and resumed sessions on local and Remote-SSH hosts, with no disclosure or opt-in gate. Reuse supported local OMP memory configuration; otherwise initialize per-project Mnemopi with full-text-only retrieval and `llmMode: none`. Document other supported memory modes' data flow and report setup failures explicitly.
- Keep ACP MCP configuration empty by default. Do not import or reuse OMP/Copilot MCP configuration implicitly. Add curated stdio-server configuration only after a concrete required server is identified; no HTTP/network MCP bridge in the initial release.
- Complete keyboard/accessibility, high-contrast, reconnect, diagnostics, and Webview security work.
- Iterate visually against Copilot Chat and the supplied screenshot, using official VS Code UX/Webview documentation where helpful. Verify compact and expanded transcript layers before considering UI polish complete.

**Exit criteria:** a fresh user can install the private VSIX, install or select OMP, authenticate with OMP, open a workspace, run a task, inspect and resolve supported changes, and understand where credentials, local memory, and project context are stored. Visual comparisons confirm the layered, compact Copilot-style transcript in expanded and collapsed states, with any unavoidable differences documented.

### Milestone 5: Optional verified OMP runtime manager

**Current status:** manual executable selection works; no downloader implemented. Remains optional and conditional on trustworthy upstream provenance.

- Keep the first private/local-only VSIX usable with a user-installed OMP executable selected by setting or discovered on PATH.
- Check official OMP release artifacts, supported operating systems/architectures, licensing, and the availability of trustworthy checksums/signatures before implementing downloads.
- If provenance can be verified, prototype an explicit user-initiated, version-pinned download into extension-managed storage on the execution host. In Remote-SSH, install the runtime on the remote extension host, not the UI client.
- Verify the artifact before execution, install atomically, support cancellation/retry, and never silently run an unverified binary. If reliable verification is unavailable, keep manual installation as the only supported path.
- Do not add a bundled copy of the current approximately 279 MB Linux binary to the VSIX by default.
- Defer general cross-platform and remote-host support until each runtime/architecture combination is tested.

**Exit criteria:** the private VSIX works with a manually installed OMP on local and Remote-SSH hosts. Any optional downloader either verifies pinned official artifacts on supported hosts or remains disabled with a clear manual-install fallback.

### Milestone 6: Quality, GitHub Linking, and Private Releases

**Current status:** local quality infrastructure and a GitHub Actions quality-workflow definition exist. No local Git repository/remote or verified hosted run; release automation is not implemented.

- Preserve the implemented lint/format/type/test/coverage/complexity/architecture gates and tighten-only baseline policy. Retire the remaining 19 exception entries incrementally without weakening defaults.
- Initialize the repository, review the initial tracked-file set for private artifacts/secrets, and create or connect the approved repository under `qu-gg`. Confirm name/visibility and ownership before pushing.
- Link repository/issues/homepage and release documentation as appropriate; decide publisher/license for private distribution rather than treating placeholder metadata as final.
- Run the existing quality workflow on the linked repository and require its actual status in branch rulesets. Keep workflow permissions minimal and baseline changes reviewed.
- Define tag/version/changelog policy and an approved GitHub Actions release workflow that builds a VSIX only from the intended passing commit, checks package contents, and attaches versioned artifacts/checksums to a GitHub Release.
- Require the combined native release check and extracted-VSIX smoke test. Decide how supported native/remote runners or recorded manual approval satisfy gates that the current credential-free CI does not run; never silently skip them.
- Regenerate the package after the latest refactors, verify clean-machine installation/update and document rollback. Marketplace publication and runtime bundling remain separate decisions, not assumed work.

**Exit criteria:** the approved `qu-gg` repository has verified hosted checks and protection, and an intended tag produces a traceable, tested private VSIX through a least-privilege release path. Repository existence, linked workflows and a distributable release must be demonstrated, not inferred from local YAML or packaging scripts.

## 7. Test Strategy

This section is the acceptance inventory, not a list of tests all currently passing. See the current checkpoint, Section 13 and [QUALITY.md](QUALITY.md) for implemented evidence and [TODO.md](TODO.md) for remaining cases.

### Protocol and process tests

- Initialize/capability negotiation, session lifecycle, streamed messages, malformed frames, request correlation, cancellation, process exit, restart, stderr-only diagnostics, and large diff payloads.
- Session switching/resume with at most one active session/process per window; switching must not implicitly Keep/Discard pending changes.
- OMP compatibility for the actual installed version and a later supported version.
- Missing executable, invalid executable, missing GitHub Copilot authentication, unavailable model, and enterprise/account errors.

### File review tests

- Existing file edit, new file, delete, rename, multiple edits to one file, multiple files, empty file, line-ending changes, Unicode text, and large-file limits.
- Keep/discard individual hunks, whole files, and all changes.
- Multiple prompts with unresolved changes, cumulative diffs across turns, agent-only follow-up writes, partial Keep followed by new edits, and Keep all establishing a fresh review baseline.
- Existing user modifications before the agent run, user changes after an agent edit, external formatter changes, stale versions, and patch-context mismatch.
- Ensure discard never removes pre-existing changes and never writes outside the approved workspace roots.
- For targets outside all active workspace roots, test approve-once, reject, and cancel for create/edit/delete/move; rejection and cancellation must leave the target unchanged.
- Verify that an open editor tab outside the workspace is still treated as sensitive, while files under any active multi-root workspace folder are not.
- Test symlink/path traversal and remote URI authority handling; fail closed when scope cannot be established.

### Remote and UI tests

- Local workspace and Remote-SSH workspace with different executable paths and OMP auth state.
- Automatic root selection for single-folder and multi-root windows, active-editor and first-root fallback, stable session roots despite editor focus changes, and empty-window or removed-root handling.
- Open/unsaved editor buffer, Webview recreation, extension reload, remote disconnect, and child process termination.
- Secondary-sidebar placement, editor-tab diffs, and pending review restoration/revalidation after session switching/resume.
- Independently collapse/expand turn activity and tool details; verify final answers, pending approvals, actionable failures, and review controls remain discoverable without reopening verbose output.
- Stream mixed progress/tool updates and large command output; verify bounded collapsed height, stable disclosure state, and no forced scroll jumps while reading earlier content. Preserve disclosure state after Webview recreation.
- Compare screenshots with Copilot Chat/reference imagery at matching narrow and wide sidebar widths in light, dark, and high-contrast themes, including running, completed, failed, approval, expanded, and collapsed states.
- Keyboard-only operation, screen-reader labels, light/dark/high-contrast themes, and small sidebars.

### Memory defaults tests

- Verify memory is enabled for every new and resumed extension-managed session on both local and Remote-SSH hosts without a disclosure or opt-in gate.
- Verify existing supported local backend/scope settings are retained and an unconfigured setup receives per-project Mnemopi with full-text-only retrieval and `llmMode: none`.
- Verify memory setup failures are reported, local-only defaults do not invoke model-backed extraction, and no credentials, memory, or remote-service configuration are silently copied between hosts.

### Mutation coverage tests

- Verify all enabled file-mutating OMP tools pass through the extension's sensitive-file guard and review journal; ensure unsupported paths are disabled.
- Verify shell commands retain OMP's command-level approval and clearly state that their file side effects are reviewed through Source Control/Git, not extension hunk controls.

### MCP configuration tests

- Confirm new ACP sessions receive an empty MCP-server list by default.
- Confirm OMP's normal MCP config and VS Code's Copilot MCP config are not silently imported.
- If curated stdio MCP support is later added, test explicit user selection, launch host (local versus Remote-SSH), cancellation, restart, environment-secret redaction, and failure handling.

## 8. Security, Privacy, and Reliability Requirements

- OMP runs with the permissions of its extension host. In Remote-SSH, that is the remote account. Treat ACP terminal and filesystem requests as privileged operations.
- Do not enable OMP yolo/auto-approve by default. Honor OMP permission requests and present the full command/path and scope before asking for approval.
- Before any mediated create/edit/delete/move outside every active workspace root, show the operation, target, and proposed diff/summary and require approve-once. Reject/cancel without mutation; do not remember sensitive-path grants in the MVP.
- Constrain filesystem requests to active workspace roots by default. Treat an already-open but out-of-workspace file as sensitive, and do not let model-generated paths authorize reads or writes on their own.
- Per-file sensitive-path approval cannot cover arbitrary terminal side effects. Keep shells disabled until command approval and lifecycle handling are implemented and tested; state the limitation when enabling them. Do not add command snapshots in the first release.
- Do not read VS Code private authentication stores or pass their tokens to OMP. Use OMP's documented authentication flow.
- Never put credentials in workspace config, logs, telemetry, crash reports, process arguments, or Webview state.
- Enable memory by default without a disclosure or opt-in gate. Document scope and data flow; the default local Mnemopi preset must disable model-backed extraction and remote memory services. Report setup failures rather than silently disabling memory.
- Do not launch MCP servers by default. If curated stdio servers are added later, require explicit selection and review their commands, host, environment, and data access.
- Store review snapshots in extension-managed storage, not tracked project files. Set a retention/cleanup policy and protect snapshots as potentially sensitive source code.
- Harden Webview message handling and content security policy; treat model output, file contents, and tool results as untrusted display data.
- Preserve file encodings/line endings where supported; refuse binary or oversized text changes rather than silently corrupting them.

## 9. Non-Goals for the First Release

- Replacing or modifying VS Code's private Local harness or native Copilot Chat internals.
- Registering a new first-party Session Target without a documented public extension API.
- Reusing the Local harness's private working-set data structures.
- Matching the OMP terminal TUI pixel-for-pixel or embedding it as a Webview.
- Inline completions, cloud/hosted execution, or synchronizing OMP sessions across products.
- Arbitrary SSH hosts that are not opened as the current VS Code workspace.
- Terminal/script mutation snapshots or per-file hunk review for shell side effects; use VS Code Source Control/Git for those changes in the first release.
- Network MCP services or a bridge to automatically reuse VS Code/Copilot MCP configuration.
- A bundled OMP executable in the first VSIX. A verified, user-initiated download is conditional on confirming release provenance and platform support.

## 10. Decisions Confirmed

1. **Distribution:** start with a private/local-only VSIX. Do not plan Marketplace publication as a first-release requirement.
2. **OMP runtime:** support a manually installed OMP executable first. Investigate an optional, user-initiated downloader for version-pinned official builds only when provenance and platform support can be verified; otherwise keep the manual-install requirement.
3. **Review semantics:** use post-write Keep/Discard for ordinary in-workspace edits. Allow continued prompting with unresolved changes and accumulate edits across turns until explicitly Kept or Discarded; partial Keep advances only the accepted baseline. For every mediated create/edit/delete/move outside all active workspace roots, require approve-once before mutation. An open editor tab does not make an out-of-workspace target trusted. Reject/cancel leaves it unchanged; approved changes still enter the review journal.
4. **Terminal mutations:** command-only Linux shells require explicit command-level approval. No terminal snapshots or extension-owned per-hunk review for shell/script side effects are implemented. Use VS Code Source Control/Git for command-produced file changes.
5. **Memory:** enable OMP memory by default for every extension-managed session, local or Remote-SSH, with no disclosure or opt-in gate. Reuse supported local OMP backend/scope settings; otherwise initialize per-project Mnemopi with full-text-only retrieval and `llmMode: none`. Document other supported local modes' data flow without blocking activation. No network memory bridge or Hindsight setup in the first release.
6. **Remote scope:** support the workspace opened in the active VS Code window, including a Remote-SSH workspace. Do not launch separate OMP-managed SSH targets.
7. **MCP:** start with no MCP servers. Section 4.7 explains the choices. If a specific server is later required, prefer an explicitly selected, curated local stdio server on the same host as OMP. Do not reuse Copilot's MCP configuration implicitly or add an HTTP/network bridge in the first release.
8. **UI placement and style:** default to the secondary sidebar; open file diffs in editor tabs. Closely follow the supplied Copilot Chat screenshot and live Copilot Chat during visual iteration: collapsible turn-level progress/thinking, independently expandable command/tool details, and a separate user-facing answer. Use official VS Code UX/Webview documentation and screenshot comparisons to guide fidelity.
9. **Sessions:** allow one active OMP session/process per VS Code window, with session switching/resume and persistent pending review. Concurrent sessions are not required for the first release.
10. **Workspace root:** infer the root from the open VS Code workspace without a routine picker. Use the sole folder in a single-folder window; in multi-root windows, retain a valid resumed root or choose the active editor's root, then the first declared root. Keep the chosen root stable per session; all declared roots remain valid workspace boundaries.
11. **Historical editing:** the first version rewinds conversation context only. Editing an earlier prompt must not restore, delete, or otherwise modify workspace files, unsaved buffers, or pending review records. Forks likewise leave the shared workspace unchanged. Historical file restoration is deferred; ordinary subsequent model-driven writes still use the existing approval/review safeguards.

## 11. First Implementation Slice: Local Portion Delivered

The disposable local slice now launches configured OMP over ACP with OMP-managed Copilot authentication, no MCP servers, streamed prompts, mediated text reads/writes, outside-workspace approval and cumulative file-level review. Native tests verify dirty-buffer baselines, CRLF preservation and rejection of an already-open outside-workspace file. Real model spikes also verified approval and reversible writes.

The remaining remote half must repeat representative tasks in an actual Remote-SSH window with OMP and authentication on that host. Broader tools must not inherit a safety claim from the text-write slice: each needs its own mediation and acceptance proof before enabling. Continue with the milestone gaps and [TODO.md](TODO.md), not a new local scaffold.

## 12. Local Feasibility Checkpoint

Implemented a private local alpha against OMP 18.21.0, ACP v1, SDK 2.7.0, and VS Code 1.146.0. It spans substantial Milestone 1 work, local portions of Milestones 2-4, conversation-only history, and quality infrastructure. Milestone 0/2 remote gates and the full MVP remain incomplete.

### Verified Locally

- OMP's existing GitHub Copilot login works without reading or copying credentials. A real `github-copilot/gpt-4.1` request returned the exact requested `OMP_ACP_OK` text.
- The real extension host activates the secondary-sidebar view, launches OMP, and discovers authenticated model controls.
- Real model-driven text writes pass through ACP client handlers. Two turns accumulate against the original baseline; Discard preserves pre-existing user work.
- Outside-workspace write rejection leaves the target unchanged; approve-once produces a reversible review record. Unit tests cover cancellation during pending approval.
- A native editor integration test proves an already-open outside file still requires approval, unsaved user buffers form the rollback baseline, and CRLF files retain their line endings.
- 255 application and 18 quality-tool tests pass, with 98.98% production line coverage, 122 architecture modules/zero violations and zero metric exceptions. Deterministic evidence adds bounded retention/export/cleanup failures, legacy-state migration, 5,000-turn persistence and 500-turn DOM probes. Native gates also cover read-only storage inspection, inline approval lifecycle/theme tokens, partial hunk review, immutable multi-context replay, instruction discovery, serialized/removed/stopped follow-ups, populated compaction failure/Stop, hook refusal and twelve actual hard-crash/reopen stages, without paid inference.
- Default local-only Mnemopi initializes its SQLite database. New/load requests explicitly pass an empty MCP-server list.
- Production Webview assets were inspected in a browser fixture at 280/360/600-pixel widths with dark/light/high-contrast variable sets. Checks cover independent disclosure state, final answers outside activity, draft retention, scroll retention, sanitized model content, loaded Codicons, and no horizontal overflow. This is not a full live Copilot screenshot-parity check.

### Mutation Boundary and Remaining Gates

OMP's native writer supports archive, database, internal-URL and executable-bit side effects; `tools.xdev: false` alone is insufficient. The explicit guard/allowlist admits supported text reads/writes, mediated native edits/deletes/moves, command-approved Linux shells and local memory/planning. LSP, delegation, unknown tools, special targets, executable changes and unmediated shell variants remain denied.

Local history-crash, phase/I/O and protected storage-policy acceptance cover the documented matrix; this does not certify every fault permutation, physical-disk exhaustion, hostile same-user filesystem races or power loss. Multi-root changes, broader assistive-technology and full populated Copilot parity checks, upstream development audit fixes and Remote-SSH verification remain outstanding. Unsupported mutation routes stay disabled rather than inheriting text or shell approval. Native multi-file calls are not atomic, and deliberately detached processes/external effects cannot be undone. Repeat acceptance on a real Remote-SSH host before considering Milestone 0/2 complete.

Development and reproduction commands, storage/data flow, packaging, and current restrictions are documented in [README.md](README.md).

### Reference-Driven Chat Iteration

The chat uses a joined file-review/composer dock with dense rows, operation-aware delete/rename labels, totals and bulk Keep/Undo. Command-approved shell output renders as bounded terminal rows with copy actions. Thinking opens by default and closes when activity advances or finishes, while manual reopening remains possible.

A Session Context popover displays validated ACP token/window/cost values, with detailed `/context` inspection and direct `/compact` actions gated by OMP's advertised commands. No Copilot credit counts or system/tool percentage breakdowns are invented. Previously reported usage is marked stale after compaction or model changes until OMP reports new data. The real runtime's command advertisement and empty-session command handling were verified; an empty session correctly refuses compaction as too small. Installed-OMP acceptance also proves generated populated-session summaries, unchanged pending attachments, stale-to-fresh usage, applicable-summary selection and populated summarizer failure/Stop without a success event. Host fixtures preserve previously reported cost and clear compaction UI even if its final save fails.

## 13. Historical Prompt Editing and Forking Investigation

**Status: conversation-only local alpha implemented and verified for the cases below.** Prompt editing and selected-turn forks use native OMP history, not transcript truncation. Files, unsaved buffers, and pending review records/ownership remain unchanged. This is not completion of the full MVP or every history acceptance gate.

### Verified Mechanisms

- VS Code's public workbench source separates conversation editing from workspace restoration. Its submit action identifies the edited request and affected later requests, restores the chat-editing snapshot when applicable, then submits replacement input. Timeline checkpoints provide the file state; hiding transcript rows alone is not the mechanism.
- VS Code's local fork action clones a retained request prefix into a new session. Forking from a request excludes that request; forking from a response includes its request/response. Contributed session providers supply their own fork operation. The local fork action does not itself restore a workspace checkpoint.
- OMP 18.21.0 owns an append-only entry tree with durable entry IDs, parent links, and a selected leaf. Its context builder follows the selected root-to-leaf path, including settings, tool history, and applicable compaction. We should reuse it rather than reconstruct context from displayed Markdown.
- Installed OMP advertises ACP whole-session fork. A disposable fixture-provider probe verifies independent identity and original access; native-host tests additionally verify populated before/after forks, complete tool pairs, original archive reopening, and process-restart durability.
- ACP SDK 2.7.0's `ForkSessionRequest` has no historical entry selector. The pinned OMP ACP handler calls `session.fork()` without an entry ID. The implemented explicit extension bridge invokes native `navigateTree(targetId, { summarize: false })` through its command context, while ACP continues to mediate file writes.
- OMP's `AgentSession.branch(userEntryId)` creates a new session ending immediately before the selected prompt. `navigateTree(userEntryId, { summarize: false })` rewinds before that prompt within the same entry tree. ACP streaming/replay message IDs are generated independently and must not be used as durable entry IDs.

### Implemented Behavior and Integration

- **Edit and Continue:** show an editable original prompt and attachments; Cancel leaves everything unchanged. On submission, move conversation context to the boundary immediately before that prompt, exclude the old prompt and all later messages from active model history, and submit the replacement. Retain the abandoned branch for recovery rather than destructively rewriting history. Do not restore files or invoke Keep/Discard; pending review records remain intact. Make the conversation-only boundary explicit before submission.
- **Fork From Here:** create and select a new session, leaving the original conversation intact. A prompt-level action forks before that prompt and prefills it; an answer-level action includes the completed turn and its tool history. Forks are context-only in the shared workspace, without file restoration or workspace isolation. Keep existing pending-review ownership intact.
- Keep ACP and the existing mediated-write guard. First prove an explicitly loaded, version-pinned OMP extension bridge can enumerate canonical entries, report the durable session/leaf, and perform native navigation through ACP command contexts. Validate host requests, entry membership, returned IDs, and cancelled operations; do not expose a model-callable history-mutation tool or accept arbitrary session paths. If the bridge cannot support this safely, stop at that boundary rather than silently replacing ACP with RPC.
- Persist mappings from local turn IDs to canonical user-entry and completed-turn boundaries, including attachments and compaction boundaries. Track durable session identity separately from the ACP handle, which can survive a native session change. Capture real boundaries after operations; never match repeated prompts by text or truncate only the UI.
- Use navigation without abandoned-branch summaries for strict rewind. Such summaries can be attached at the new leaf and would reintroduce information the user asked to exclude. Verify that installed hooks cannot inject abandoned-history summaries or other future context despite `summarize: false` before enabling the feature.
- Serialize history transitions with prompts, compaction, review, and session switching. Preflight conversation boundaries and native history prerequisites; preserve a recoverable transition record, and do not submit input after a partial failure or cancellation. Refuse busy/unsupported operations rather than guessing.

The bridge exchanges strict, bounded metadata through private request/response files under the canonical guarded artifact root. Navigation must return exactly the requested retained prefix before a non-model custom entry persists the new leaf; unknown summaries fail closed. Inspection makes no model request and changes no native history. No arbitrary session paths or model-callable mutation tools are exposed.

ACP's restart resolver does not enumerate the custom session directory. Resume therefore opens a fresh ACP handle and invokes a validated private-file native session switch. Local session identity remains stable for review ownership and is separate from the transient ACP handle and native durable ID. Older private filenames can be recovered by their canonical session-ID suffix; an empty unpersisted session starts fresh under its existing local identity. Missing populated artifacts are refused without deleting local state.

One identity-bearing host operation state replaces independent busy/history/connection flags. It serializes review resolution, configuration, session selection, prompts, and history; late cleanup cannot clear a newer operation. Stop is limited to cancellable prompts. Shutdown aborts writes and closes the process even during a history transition; persisted intent supports conservative recovery. Native tests exercise overlapping-action refusal and cancellation before dispatch and inside the fixture provider. Nine deterministic interruptions and twelve externally controlled SIGKILL boundaries prove conservative reactivation, including original/archive access, unchanged actual dirty editors/review ownership and no automatic replacement replay.

### Workspace and Memory Boundaries

The current review journal retains only the first unresolved preimage and latest postimage per session/file. Keep removes that record. It cannot restore a historical turn, including changes previously kept.

Historical file restoration is explicitly deferred, not a prerequisite for the conversation-only first version. If added later, it needs immutable per-turn file versions/checkpoints in private extension storage, independent of pending Keep/Discard records. Before restoring the selected and later mediated writes, it would need to check every affected current buffer/disk image against its expected state, refuse newer user/external changes, preserve original unsaved-buffer baselines and line endings, and support recovery from failed multi-file restoration. A context-only rewind must not be presented as a workspace rewind.

Rewound conversations and forks still use the current working directory, including files changed after the selected turn. Preserve pending-review ownership and require explicit conflict resolution for subsequent writes; do not duplicate or silently transfer another session's pending changes. Any future file-version retention and cleanup must preserve data needed by advertised checkpoints.

Neither operation automatically undoes shell/external side effects, shared long-lived memory, or changed system/project instructions. Memory remains enabled under the existing decision; branch-aware memory isolation would be separate work. The initial contract must explicitly distinguish selected conversation history from complete historical machine state.

Native testing observed abandoned-turn markers recalled by Mnemopi in `systemPrompt` while conversation `messages` correctly excluded those turns. Assertions therefore distinguish conversation history from shared memory, rather than claiming complete forgetting. Current fixture tests keep memory enabled in a disposable database. Earlier markers in existing memory were not deleted.

Compaction is not necessarily a hard boundary: OMP retains older entries and selects compaction only along the chosen path. Native before/after edit/fork checks now prove exclusion or retention of the generated summary with a future-only sentinel. This depends on retained assets; do not promise recovery after history/artifact deletion or byte-identical provider requests/cache state.

### Acceptance Checkpoint

- Prove selected-prefix context contains no abandoned future sentinel, including one present only in a later compaction/branch summary. Test targets before and after compaction, root/first prompt, repeated identical prompts, attachments, complete tool-call/result pairs, and interrupted turns.
- Prove prompt-level exclusion versus answer-level inclusion, unchanged source after fork, recoverable abandoned branches, and correct durable identity/mappings after reload. Cover unsupported capabilities, bad IDs, busy state, cancellation, hook refusal, and partial transition failure.
- Prove rewind/fork itself leaves file contents, existence, unsaved buffers, and pending-review records/ownership unchanged, including repeated writes, prior Keep/Discard, CRLF, new files, newer external edits, cancellation, and failure. Subsequent model-driven writes must retain the existing mediated approval/review safeguards; no history operation may invoke automatic rollback.
- Keyboard-accessible edit/fork actions are implemented after the native context proof. Browser checks cover Cancel without mutation, explicit success/failure acknowledgement, retained failed drafts, source composer preservation, fork-prefill ordering, focus/selection, and no overflow at 280/440/720 pixels across dark/light/high-contrast fixtures. The browser fixture does not establish backend correctness.

Verified native cases include actual edited provider-message context, prompt-level exclusion versus completed-answer inclusion, first-prompt forks, complete tool-call/result pairs, original attachment snapshots after editor changes, unchanged dirty buffers/files/review ownership, archive reopening, fork-after-reconnect, legacy and empty resume, overlap refusal, and pre-send cancellation. Populated-compaction before/after edits/forks retain only applicable summaries, including a sentinel absent from original messages; canonical IDs distinguish identical prompts, interrupted provider turns retain before-prompt boundaries and refuse after-answer forks, and mixed prior Keep/Discard/create/delete/external-edit histories preserve file state and review ownership. Actual installed-OMP hooks refuse edit/fork after mixed review operations without sending replacements. Deterministic tests add unchanged/rewound/ambiguous durable-state recovery, stale/bad/busy requests and injected-summary rejection.

Nine deterministic interruptions freeze later persistence and reactivate from the last durable state. The separate required native crash suite externally kills the actual extension host and OMP at twelve archive/intent/navigation/verification/rewind/submission/final-save/fork boundaries. A new host reopens the same storage in the surviving workbench; exact files, dirty buffers and review ownership survive, original/archive branches reopen, unfinished turns cancel and provider captures prove no automatic replay. Reconciliation permits only correctly linked non-conversational bookkeeping after the verified original or rewound prefix; added messages, summaries or altered prefix metadata fail closed.

Phase tests cover broker/history/pre-send/provider/cleanup/final-save Stop. Storage tests inject `ENOSPC`, `EIO` and `EACCES` into partial state writes, rename, configuration writes and memory-settings queries, plus pre-send failure and combined Stop/final-save failure. Committed state survives, temporary partial files are removed and repaired continuation requires an explicit request. This completes TODO #4's [supported local matrix](QUALITY.md#todo-4-fault-matrix), not every possible fault combination or kernel/power-loss scenario. Per-turn file restoration, OMP-internal memory-database recovery, remote/cross-platform acceptance and the full MVP remain separate.

### References and Reproduction

- [VS Code submit/edit actions](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts), [editing checkpoints](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingSession.ts), and [fork actions](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatForkActions.ts). These are public `main` source references, not private APIs to call or a claim of exact installed-build parity.
- OMP **v18.21.0**: [ACP implementation](https://github.com/can1357/oh-my-pi/blob/v18.21.0/packages/coding-agent/src/modes/acp/acp-agent.ts), [native session operations](https://github.com/can1357/oh-my-pi/blob/v18.21.0/packages/coding-agent/src/session/agent-session.ts), [tree semantics](https://github.com/can1357/oh-my-pi/blob/v18.21.0/docs/session-tree-plan.md), and [context reconstruction](https://github.com/can1357/oh-my-pi/blob/v18.21.0/packages/coding-agent/src/session/session-context.ts).
- Run `OMP_SPIKE_HISTORY=1 OMP_SPIKE_PROMPT=0 OMP_SPIKE_CONTEXT=0 node scripts/acp-spike.mjs` for disposable inspection/fork/native-navigation checks with the local fixture and enabled isolated memory. It makes no paid model request. Run `npm run test:extension` for the broader actual-extension workflow, or set `VS_OMP_VSIX` to test an extracted package.
