# Changelog

## 0.1.8

Feature release for Local-style chat controls and in-place retry.

- Finish the Local transcript/composer pass: Start Over with its divider
  treatment, `Default permissions`, completed status and exact diff stats,
  clickable tool headers, tool-type icons, semantic tool-chain summaries,
  distinct search phrase/file labels, denied/skipped outcomes, and a narrower
  status bar that keeps the permission label readable.
- Add **Retry** to the latest completed answer. It rewinds and resends the same
  prompt in the same session, preserving attachments, pending file review, and
  the active command-permission mode. Manual Edit/Fork history rollback still
  resets elevated modes. Retry refuses stale, running, missing, or blank-prompt
  targets and never creates an active fork.
- Refresh the native 600x900 and 1440x900 comparison captures and provenance,
  and add `npm run capture:docs` for an isolated, toast-cleared docs capture.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 19.2.1 acceptance profile.
  Remote-SSH, multi-root lifecycle and other platforms remain outside that
  profile. No Marketplace distribution is included.

## 0.1.7

Feature release for transcript/streaming UX and prompt reuse.

- Show observed output throughput and first-text delay in Session Info. The
  estimate uses measured agent-text timing and output characters, pauses during
  thought/tool phases, stays unknown without data, and does not issue an extra
  model request or invent provider token claims.
- Recall previous prompts with Up/Down in the composer. The active session
  traverses newest-first, then recent same-root sessions add a bounded,
  deduplicated list; the in-progress and per-session drafts survive, and the
  prompt-edit field and IME/selection cases are guarded.
- Modernize the transcript toward the Local workbench reference: role identity,
  persistent answer actions, scannable activity/tool status, restrained
  theme-token styling, and patch-based render batching that preserves scroll,
  focus, selection, and disclosure state.
- Stream live owned shell/tool output into the chat tool card with explicit
  Live/Truncated badges and bottom-only auto-scroll. Output is correlated to an
  exact block, bounded and UTF-8-safe, retired on Stop/session change/takeover,
  and never persisted as the authoritative ACP result.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 19.2.1 acceptance profile.
  Remote-SSH, multi-root lifecycle and other platforms remain outside that
  profile. No Marketplace distribution is included.

## 0.1.6

Feature release for the inline command-permission menu.

- Replace the native Quick Pick and modal warning flow with a menu that expands
  inside the chat above the status bar. It keeps the current mode visible,
  lists Ask, Rules, Allow All and YOLO with descriptions, and opens user command
  rules from the same panel.
- Keep elevated permission safety explicit: Allow All and YOLO require their
  warning and an Enable step inside the menu, and the host still refuses an
  unconfirmed elevation and rechecks trust and command-cleanup state.
- Keep the selected permission mode across new chats and reconnects, including
  the first prompt after connecting. Elevated modes reset on extension reload,
  workspace trust change, or history rollback; a prompt blocked by an in-flight
  permission change now reports that boundary directly.
- Preserve host-side read, write, permission and terminal failure reasons in ACP
  responses. A denied write or pending-review conflict no longer reaches the
  model as only `Internal error`.
- Prevent duplicate session records: a fresh connect reuses an existing native
  identity, replaces an idle empty chat only when it has no turns, pending
  review, or attached context, rolls back a failed post-bind connection without
  losing staged context, and clears a stale active id on load. New Session does
  not carry the replaced chat's unsent composer text; attached context is
  protected. The picker labels an active empty chat as New Session and keeps
  inactive empty records that hold an unsent draft or attached context reachable.
- Upgrade the tested OMP profile to 19.2.1. Runtime preflight accepts newer
  19.x releases; release acceptance remains pinned to the tested version.
- Treat only a leading interpreter shebang as an executable-bit mutation. A
  `#!` literal elsewhere in a file no longer blocks native edit, write, move or
  rename review.
- Make a repeated `bash` stop on an already released managed job a no-op instead
  of reporting an unknown terminal.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 19.2.1 acceptance profile.
  Remote-SSH, multi-root lifecycle and other platforms remain outside that
  profile. No Marketplace distribution is included.

## 0.1.5

Feature release for the responsive session picker and browser hardening.

- Replace the tabbed session manager with a VS Code-style session picker:
  `Today`, `Yesterday`, `Last 7 days`, and `Older` groups, relative activity,
  pending-review diff totals, search, and an optional Archived group. Panels at
  least 620 px wide show the picker beside the chat as a remembered, collapsible
  sidebar; narrower panels keep the full-surface picker.
- Harden OMP-owned Playwright launch: use `omp.browser.executablePath`, then
  pinned Chromium, then common system Chromium/Chrome/Brave executables, with an
  actionable error when none launch. Add **Linewise: Open in VS Code Browser**
  for a user-visible integrated-browser tab of the current page URL; it is not
  agent-controlled and does not synchronize state.
- Fail fast when a stale mutation broker owner is no longer running, instead of
  waiting for an outside-workspace read or mutation response that cannot arrive.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 18.21.0 acceptance profile.
  Remote-SSH, multi-root lifecycle and other platforms remain outside that
  profile. No Marketplace distribution is included.

## 0.1.4

Patch release for native edit provenance and recoverable retries.

- Fix native edit provenance: pin OMP's child process to hashline read/edit mode,
  share OMP's session edit store when available, record the requested read range
  when the body has no hashline lines, keep the read snapshot after recoverable
  validation errors, serialize unawaited read results before edit, and refuse a
  dirty open buffer before staging. Directory listing remains an OMP read-tool
  capability above the file-only ACP text read.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 18.21.0 acceptance profile.
  Remote-SSH, multi-root lifecycle and other platforms remain outside that
  profile. No Marketplace distribution is included.

## 0.1.3

Patch release for clipboard image context.

- Paste PNG, JPEG or WebP images directly into the composer to attach them as
  explicit context. The webview reads clipboard pixels, the host validates and
  stores one bounded batch, and the existing composition path sends the image
  with the submitted prompt and history replay. Text pasted alongside an image
  is inserted into the draft.
- Keep the existing limits: up to eight attachments, 512 KiB per image and 1 MiB
  of images in total. Oversized or unsupported clipboard data stays local and
  reports the reason without changing the current attachments.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 18.21.0 acceptance profile.
  Remote-SSH, multi-root lifecycle and other platforms remain outside that
  profile. No Marketplace distribution is included.

## 0.1.2

Patch release for new-chat OpenRouter provider routing.

- Add new-chat OpenRouter upstream provider selection. A secondary route picker lists providers from OpenRouter's public endpoint catalog, defaults to Auto routing, and pins the selected provider when the first prompt starts a new OMP session. Route changes are unavailable after a chat has turns. OMP 18.21.0 records the base model, not the upstream route, in its session journal, so resuming returns to Auto routing.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 18.21.0 acceptance profile. Remote-SSH, multi-root lifecycle and other platforms remain outside that profile. No Marketplace distribution is included.

Release status is recorded by the matching GitHub tag and published prerelease.
Publication requires the release gates; the source version alone does not mean
that a release exists.

## 0.1.1

Patch release for the provider model picker and tool-schema compatibility.

- Add a searchable, provider-grouped inline model picker with keyboard navigation, focus and scroll preservation, and an on-demand catalog. It replaces the native QuickPick.
- Reuse the last active model for new sessions; an exact `omp.model` seeds the first session. Provider authentication and credentials remain owned by OMP.
- Flatten provider-facing bash/browser/editor tool schemas to object roots so OpenAI-compatible providers such as OpenRouter Terra accept the full tool catalog. The runtime validators remain authoritative for action-specific fields and approval paths.
- Disclose that switching to a model from another provider sends subsequent prompts and conversation context to that provider.
- Keep the local Linux x64, VS Code 1.147.0 and OMP 18.21.0 acceptance profile. Remote-SSH, multi-root lifecycle and other platforms remain outside that profile. No Marketplace distribution is included.

## 0.1.0

Linewise's first public-release candidate: an early local-Linux x64 preview.
The matching GitHub release records publication and provides the accepted VSIX
and checksums. No Marketplace distribution is included.

- Adopt the selected Line Decisions artwork in the README and extension package.
  Keep the owner's personal motivation section verbatim.
- Provide OMP/ACP chat, explicit context, model controls, questions, Stop and
  conversation history through public VS Code APIs.
- Review text changes hunk by hunk in a full-file editor with floating Keep/Undo;
  preserve accepted baselines, pending review on reload and stale-change refusal.
  Creation, deletion and moves use whole-operation review.
- Keep command Rules/Ask and explicitly confirmed session permissions, independent
  file/web consent, private local storage and owned-process cleanup. Commands run
  with host permissions, not in an OS sandbox; shell effects are not undoable.
- Preserve extension ID `vs-omp-local.vs-omp` and the `omp.*` settings/commands.
  Require trusted local Linux x64, VS Code 1.146.0 and separately installed OMP
  18.21.0. Remote-SSH, multi-root lifecycle, other platforms/providers and broad
  accessibility support remain unvalidated.
- Retain checksum-bound hosted candidate/native/install/update acceptance and
  manual smoke gates. Install/update manually; no previous published rollback
  package exists for this first release.

## 0.0.2

Historical private Linewise local-Linux x64 candidate; never publicly released.

- Adopt Linewise as the public name while preserving the extension identity,
  command/settings IDs and persisted compatibility. Add public contributor,
  security, attribution, roadmap and focused development/tool documentation.
- Make manual release authorization explicitly maintainer-scoped and
  visibility-bound, with default-private destination and protected publication.

- Guarded local OMP/ACP coding sessions with command approvals, inspectable
  file/hunk review, conversation-only history, context and compaction.
- Add explicitly confirmed, connection-only YOLO command permissions. Auto-approve
  shell syntax and ordinary destructive project operations while retaining literal
  user deny/ask rules and a small recognizable machine-destruction denylist.
  Retire late permission dialogs after reset or a newer picker; keep independent
  file/web/browser consent, Stop and process ownership unchanged. This is not an
  OS sandbox, a complete destructive-action detector or Autopilot continuation.
- Replace changed-file comparison tabs with a Linewise-owned full-file inline review
  editor and floating hunk Keep/Undo controls, without diff or CodeLens setting
  overrides. Preserve exact accepted baselines, line endings and stale-owner refusal.
- Fix repository exploration: allow in-workspace directory listings and ordinary
  nullable/default bash inputs without bypassing host approval or deadlines.
- Admit nested files, arbitrary read extensions and native line selectors; request
  host approval for outside files/directories while retaining mutation restrictions.
- Bind opaque provider tool IDs through hashed permit filenames, and publish the
  native edit input as JSON Schema so real models can supply it.
- Add explicitly enabled, bounded real-model conversation and outside-read tests;
  keep deterministic/native release gates free of inference requests.
- Remove implicit approval and execution deadlines. Positive foreground timeouts
  remain an explicit post-consent option; Stop, output/process limits and cleanup remain.
  Add explicit prompt-owned preview job controls, host-Node JavaScript/Playwright
  execution, truthful capability instructions and real screenshot/interaction tests.
- Add bounded read-only workspace discovery, diagnostics, symbols, definitions and
  references through public VS Code APIs, with private/outside filtering and Stop.
- Add bounded case-aware literal search including unsaved text, explicit partial
  scan metadata, and native user questions with choices, free text, dismissal and Stop.
- Exercise actual native question controls alongside the existing approval matrix;
  add a six-turn real-model question/search/cancellation workflow without provider mocks.
- Document Local Chat capabilities, evidence levels and the bounded parity program.
  Add a six-turn actual-provider editor/repair/check/Discard workflow, broader browser
  interaction checks and script-safe, thought-free, read-only test-chat replay.
- Private storage inspection, explicit retention/export/deletion and bounded
  recovery with the documented local deterministic/native acceptance matrix.
- Manual candidate and prerelease automation with exact-package checksums,
  maintainer-attested native acceptance and separate read-only/write-enabled jobs.
- Requires trusted local single-root Linux x64, VS Code 1.146.0 and separately
  installed/authenticated OMP 18.21.0. Remote-SSH, multi-root lifecycle, other
  platforms/providers and untrusted/virtual workspaces are not release-supported.
- The earlier development-only picomatch advisory was withdrawn upstream; fresh
  full and production audits are clean. The audit remains required, with no
  waiver or Marketplace publication included.
- Install/update manually from the verified VSIX. No previous validated release
  exists yet, so rollback is unavailable for this first cut. Package rollback
  never restores workspace files, memory or external effects.
