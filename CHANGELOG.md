# Changelog

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
