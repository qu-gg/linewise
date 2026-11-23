# Capability Matrix

Linewise is an independent alternative to the Local chat workflow, not an implementation of private Copilot services or a promise of complete parity. Current source is an early local Linux alpha. [README.md](README.md) explains the supported profile; [usage](docs/usage.md) and [tool contracts](docs/tools.md) describe the boundaries.

## Current Capabilities

| Surface              | Linewise Status                                                                                   | Boundary                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Chat and agent loop  | Streamed OMP/ACP conversation, model/thinking controls, Stop                                      | Custom webview; current provider is OMP's GitHub Copilot integration                                                      |
| Granular review      | Full-file inline editor with floating hunk Keep/Undo; file summaries and bulk actions             | Public readonly Monaco custom editor, not Local's private ordinary-editor widget; no arbitrary individual-line acceptance |
| Journal safety       | Persisted pre/post images, accepted baselines, CRLF and dirty-buffer handling, conflicts          | Journaled file-tool changes only; shell/web/history side effects are not rolled back                                      |
| Context              | Explicit editor/selection, files, images, resources, diagnostics                                  | Immutable submitted snapshots; no automatic unrelated-tab attachment                                                      |
| Activity and plans   | Collapsible activity/thinking/tools, separate final answers, Todos                                | Only exposed provider data; no invented reasoning or billing figures                                                      |
| Follow-ups           | Serialized FIFO queue, per-session drafts                                                         | Bounded transient queue; not in-flight steering or Autopilot                                                              |
| Sessions and history | Search, archive/restore, explicit resume, prompt editing and forks                                | Conversation-only; workspace files, review ownership and shared memory remain                                             |
| Commands and PTYs    | Rules/Ask, confirmed Allow All/YOLO, owned output/process cleanup, human takeover                 | Unsandboxed host execution; no existing user-terminal adoption or shell rollback                                          |
| Editor services      | Literal search, bounded lexical cache, local TF-IDF/SVD retrieval, diagnostics/symbols/references | Public-provider dependent; partial coverage is disclosed, no pretrained embeddings/downloads                              |
| Provider mutations   | Enumerated saved-text rename and code-action edits with capture/revalidation                      | No provider commands, resource operations, arbitrary LSP or complete provider semantics                                   |
| Tasks                | Exact approved process/bash snapshots and bounded OMP-owned dependency graphs                     | Not the provider scheduler, opaque executors, persistent watchers or Test Explorer                                        |
| Questions            | Native and in-chat bounded choices/free text, cancellation                                        | Not credentials or approval grants; no automatic answers                                                                  |
| Web and browser      | Consented GET/redirects; independently owned isolated Playwright pages                            | Not indexed search, authenticated account access, existing-tab sharing or a network sandbox                               |
| Notebooks            | Live cell/text/image inspection, one saved cell-source replacement                                | Serialized-text review; no kernel execution, structural cell changes or universal serializer certification                |
| Memory and storage   | Local memory; private inspection/export/confirmed retention/deletion/recovery                     | No remote memory backend; modes are not encryption, export is not resumable backup                                        |

## Evidence Levels

- **Deterministic:** protocol, policy, journal, storage, provider, lifecycle, and DOM regressions.
- **Native:** actual pinned OMP parser and VS Code workbench with scripted providers, owned processes, approvals and hard-crash/reopen checks. No paid inference is needed.
- **Visual:** production workbench captures or separately labeled browser fixtures. Theme/viewport checks do not certify every accessibility environment.
- **Real model:** separately authorized, budgeted, observed scenarios. Historical success certifies that scenario and artifact, not every provider/model or new source bytes.
- **Release:** clean commit and exact hosted VSIX with native/manual acceptance and verified download. Version 0.0.2 remains unpublished.

## Local Comparison

The intended shared workflow is chat beside code, inspectable changes, and selective review. Linewise's editor/review ownership and agent loop differ intentionally. Public comparisons must label actual versions and synthetic content; a recorded Local participant demonstrates native transcript rendering, not authenticated Local editing or full functional parity.

Do not compare private original screenshots without consent or invent their version/theme/viewport metadata. Any published comparisons should explain which surface was actually exercised and which was not. See [attribution](ATTRIBUTION.md) and [security](SECURITY.md).

## Instruction Compatibility

Instruction capture is root-only, bounded, and constrained by host policy. Pinned OMP discovery is not a grant of tool authority. Nested/user/rule/skill/template integration and every upstream discovery format are not automatically enabled or certified. Explicit editor context and submitted historical snapshots remain separate from on-disk instruction discovery.

## Remaining Gaps

Remote-SSH remains unvalidated, as do multi-root lifecycle, other platforms/runtime versions, broader model providers, alternate harnesses, physical desktop/screen-reader coverage, existing browser-tab sharing, arbitrary editor-provider commands/file operations, delegated agents, MCP import, and public artifact acceptance.

The [roadmap](ROADMAP.md) prioritizes scoped validation rather than treating partial equivalents as completed families. The [long shared ledger](TODO.md) restores atomic, claimable work and verification IDs. In particular, [SSH](TODO.md#remote-ssh), [PRV](TODO.md#model-providers), and [HAR](TODO.md#alternate-open-harnesses) separately track remote-host support, model backends, and non-OMP agent loops. A task being planned or claimed does not change this capability matrix; update it only after reviewed evidence.
