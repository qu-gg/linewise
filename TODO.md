<!-- markdownlint-configure-file { "MD033": { "allowed_elements": ["a"] } } -->

# Shared Feature And Verification Ledger

The long-form work inventory lives here. [ROADMAP.md](ROADMAP.md) sets priorities; [PARITY.md](PARITY.md) describes current capability, not promises. This ledger includes existing bounded checks, missing functionality, research decisions, and acceptance work. More checked boxes do not equal complete Local parity or release approval.

Historical `UX-*`, `T-*`, `V-*`, and `R-*` identifiers are retained. New categories extend the inventory without renumbering those references. The earlier detailed ledgers remain in Git history; private profiles, runbooks, and acceptance receipts stay private. This is a sanitized, maintained successor, not a claim that every historical sub-case has been re-certified.

## Claim A Small Task

1. Choose one **open** task, or one **research** task with a bounded deliverable. Follow dependencies before claiming a blocked acceptance gate.
2. Find an existing issue by its ID; otherwise open a [scoped proposal](https://github.com/qu-gg/linewise/issues/new?template=feature.yml). Use a title such as `SSH-03: remote workspace URI mapping`, link the exact row, and describe the smallest acceptance slice.
3. Comment that you would like to take it. A maintainer confirms scope/ownership in the issue; an unassigned row is not a reservation, and a forum comment is not merge authority.
4. Link the ID in your PR. Update this ledger only with reviewed evidence, preserving the ID and stating remaining limits. Split newly discovered work into new IDs rather than quietly expanding the original task.

Issues own active claims, progress, and handoffs. No contributor is assigned by this file. Release/security authority, external credentials, infrastructure, and real-model allowances cannot be claimed into existence. See [CONTRIBUTING.md](CONTRIBUTING.md), [QUALITY.md](QUALITY.md), and [RELEASE.md](RELEASE.md).

| State    | Meaning                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| verified | The named bounded case has source/native evidence linked below; not a whole-family or future-artifact guarantee.                            |
| open     | A scoped implementation or verification contribution is needed.                                                                             |
| research | First establish the public API, upstream identity, authority boundary, or feasibility; an honest negative result can complete the research. |
| blocked  | Depends on named work or explicit external/maintainer acceptance. Do not bypass that dependency.                                            |

## Categories

[Chat and review](#chat-and-review) &middot; [Onboarding](#onboarding) &middot; [Context and history](#context-and-history) &middot; [Instructions](#instructions-and-customization) &middot; [Editor providers](#editor-services-and-provider-edits) &middot; [Tasks and tests](#tasks-and-tests) &middot; [Terminals](#terminals-and-command-authority) &middot; [Remote-SSH](#remote-ssh) &middot; [Workspaces](#workspaces-and-platforms) &middot; [Platform compatibility](#platform-compatibility) &middot; [Model providers](#model-providers) &middot; [Harnesses](#alternate-open-harnesses) &middot; [Web](#web-and-browser) &middot; [Notebooks](#notebooks) &middot; [Storage](#storage-and-security) &middot; [Accessibility](#accessibility-and-performance) &middot; [Release](#collaboration-and-release)

## Chat And Review

| ID                             | State    | Atomic Task                                                                   | Completion Check                                                                                                                                             |
| ------------------------------ | -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a id="ux-01"></a> `UX-01`     | verified | Bounded structured questions, cancellation, and explicit answers.             | Native question controls and cancellation in [the workbench suite](scripts/native-ux.mjs); questions do not grant permissions.                               |
| <a id="ux-02"></a> `UX-02`     | verified | Session switching, search, archive, and restore in the current local profile. | [Session tests](src/test/sessions.test.ts) and [native controls](scripts/native-ux.mjs); no automatic resume generation.                                     |
| <a id="ux-03"></a> `UX-03`     | verified | Explicit file/selection context entry with immutable submitted captures.      | [Context-host tests](src/test/context-host.test.ts) retain source identity and reject stale/unowned submissions.                                             |
| <a id="ux-04"></a> `UX-04`     | verified | Approval/question/finished notifications retain session ownership.            | [Attention tests](src/test/attention-host.test.ts) and [lifecycle/privacy checks](scripts/terminal-lifecycle.mjs) cover actual output logs and late actions. |
| <a id="ux-05"></a> `UX-05`     | verified | Render chat tables and separated activity/final-answer presentation.          | [Native presentation checks](scripts/native-ux.mjs); the [Local comparison](docs/comparison.md) is recorded transcript evidence, not editing parity.         |
| <a id="ux-06"></a> `UX-06`     | verified | Refresh explicit context at the bounded compaction boundary.                  | [Compaction tests](src/test/compaction.test.ts); real generated summaries remain [V-01-1](#v-01-1).                                                          |
| <a id="ux-07"></a> `UX-07`     | verified | Keep one pending hunk, undo another, preserve accepted bytes.                 | [Hunk tests](src/test/review-hunks.test.ts), [native suite](scripts/native-ux.mjs), and [exact sequence](docs/comparison.md); no arbitrary line acceptance.  |
| <a id="ux-02-1"></a> `UX-02-1` | open     | Add a keyboard-only session search/archive/restore regression.                | Preserve selected session, draft, and focus across filtering, cancellation, and archive/restore.                                                             |
| <a id="ux-03-1"></a> `UX-03-1` | open     | Reproduce one quick-context long-path or duplicate-label failure.             | Exact attachment identity remains visible and selectable at narrow widths; no unrelated automatic attachment.                                                |
| <a id="ux-05-1"></a> `UX-05-1` | open     | Add a wide-table/long-code transcript layout fixture.                         | No overlapping text or detached horizontal scroll; test long tokens at normal and enlarged native zoom.                                                      |
| <a id="ux-07-1"></a> `UX-07-1` | research | Define optional arbitrary-line or selection-level acceptance semantics.       | Specify overlapping/adjacent edits, accepted baseline changes, CRLF, and conflict refusal before proposing mutation code.                                    |
| <a id="ux-07-2"></a> `UX-07-2` | open     | Add a keyboard focus regression after Keep/Undo closes review.                | Focus returns predictably; accepted bytes survive and no provider request is issued.                                                                         |
| <a id="ux-07-3"></a> `UX-07-3` | open     | Add a multi-file mixed text/create/move review fixture.                       | Each operation has honest controls and ownership; refusal/cancellation cannot undo an already accepted sibling.                                              |

## Onboarding

| ID                           | State | Atomic Task                                                                | Completion Check                                                                                                         |
| ---------------------------- | ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| <a id="onb-01"></a> `ONB-01` | open  | Verify installation from a genuinely clean user profile.                   | Document runtime/profile versions and first chat/review; no copied configuration, credentials, or prior extension state. |
| <a id="onb-02"></a> `ONB-02` | open  | Improve the missing OMP executable error.                                  | Missing/invalid path has actionable guidance; cancellation leaves no process or connection.                              |
| <a id="onb-03"></a> `ONB-03` | open  | Improve incompatible OMP version guidance.                                 | Distinguish unsupported CLI output/version from authentication failure; refuse unsupported protocols.                    |
| <a id="onb-04"></a> `ONB-04` | open  | Verify expired/missing authentication presentation without real secrets.   | Scripted failure remains separate from runtime failure; no account import, retries, or credential text in logs.          |
| <a id="onb-05"></a> `ONB-05` | open  | Add an empty model-catalog onboarding fixture.                             | Explain unavailable selection without inventing a default provider/model or starting a prompt.                           |
| <a id="onb-06"></a> `ONB-06` | open  | Verify development/update instructions on one additional clean Linux host. | Reproduce exact commands and native dependency loading; name distro/glibc and preserve the prior installation.           |

## Context And History

| ID                           | State    | Atomic Task                                                               | Completion Check                                                                                                                                      |
| ---------------------------- | -------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="v-01"></a> `V-01`     | verified | Preserve history/journal ownership across the existing hard-crash stages. | [Twelve-stage runner](scripts/history-crashes.mjs) and [recovery tests](src/test/history-recovery.test.ts); not real-model summary certification.     |
| <a id="v-01-1"></a> `V-01-1` | blocked  | Observe one conventional/generated/fallback summary checkpoint.           | First complete fail-closed auxiliary-request accounting offline; a new explicit finite model allowance and truthful receipts are required.            |
| <a id="v-01-2"></a> `V-01-2` | blocked  | Finish one mixed context-removal/resume/Keep/refusal continuation.        | Separately authorized generation excludes removed context; reconnect generates nothing; exact Keep/refusal bytes and unrelated dirty buffers survive. |
| <a id="ctx-01"></a> `CTX-01` | open     | Add a saved-versus-unsaved context provenance fixture.                    | Each submitted snapshot names its actual source/range; later disk edits do not rewrite historical attachments.                                        |
| <a id="ctx-02"></a> `CTX-02` | open     | Add context-size boundary and truncation presentation checks.             | Show bounded omission honestly; oversized input cannot silently become a complete capture.                                                            |
| <a id="ctx-03"></a> `CTX-03` | open     | Verify image-context failure and cancellation cleanup.                    | Unsupported/oversized image data is refused without leaking temporary paths or consuming another session's attachment.                                |
| <a id="ctx-04"></a> `CTX-04` | open     | Add a queue/draft restore regression across session switching.            | FIFO order and per-session drafts survive; cancellation never starts an abandoned follow-up.                                                          |
| <a id="ctx-05"></a> `CTX-05` | research | Specify in-flight steering versus queued follow-up semantics.             | Identify public transport support and ordering/Stop behavior; do not relabel the current FIFO queue as steering.                                      |
| <a id="ctx-06"></a> `CTX-06` | research | Specify conversation rewind separately from machine-state rollback.       | List files, shell effects, memory, and review ownership that remain unchanged; reject impossible rollback guarantees.                                 |

## Instructions And Customization

| ID                           | State    | Atomic Task                                                                   | Completion Check                                                                                                                               |
| ---------------------------- | -------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="v-04-1"></a> `V-04-1` | open     | Publish the pinned discovery/precedence matrix for instruction file families. | Name support/scope/order for AGENTS, Copilot instructions, instructions, prompts, agents, and skills; unsupported names do not silently load.  |
| <a id="v-04-2"></a> `V-04-2` | open     | Verify customization lifecycle and host authority isolation.                  | Synthetic sentinels cover trust/root/switch/reload/resume; instructions cannot grant shell/outside/private access or automatic model requests. |
| <a id="ins-01"></a> `INS-01` | research | Define nested instruction applicability for one subtree.                      | Specify precedence and canonical path/root boundaries; test duplicate names, symlinks, and disabled sources.                                   |
| <a id="ins-02"></a> `INS-02` | research | Define explicit skill activation on the supported harness.                    | Identify upstream activation support and opt-in UI/metadata without treating discovery as permission.                                          |
| <a id="ins-03"></a> `INS-03` | open     | Add malformed frontmatter and duplicate-source fixtures.                      | Bounded actionable errors and deterministic precedence; no real user customization import.                                                     |
| <a id="ins-04"></a> `INS-04` | research | Define portable customization mapping for a second harness.                   | After [HAR-01](#har-01), report unsupported semantics explicitly rather than silently rewriting or dropping instructions.                      |

## Editor Services And Provider Edits

These are **VS Code language/editor providers**, not model providers in [PRV](#model-providers).

| ID                           | State    | Atomic Task                                                            | Completion Check                                                                                                                                              |
| ---------------------------- | -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="t-03-1"></a> `T-03-1` | open     | Extend lexical-cache ignore/freshness verification by one case.        | Compare indexed and fresh scans after ignore/rename/delete/unsaved changes; report skipped/stale coverage and source ranges.                                  |
| <a id="t-03-2"></a> `T-03-2` | open     | Publish and rerun a fixed retrieval relevance fixture.                 | Keep lexical controls and nonliteral queries; identify the actual local TF-IDF/SVD backend, limits, and provenance, without calling it pretrained embeddings. |
| <a id="t-03-3"></a> `T-03-3` | open     | Accept one additional named resolved text-only refactoring kind.       | Native provider edits pass exact capture, dirty/stale refusal, Keep/Undo/reload, and Stop; attached commands remain ignored.                                  |
| <a id="t-03-4"></a> `T-03-4` | research | Establish complete provider create/rename/delete metadata feasibility. | Inspect stable public APIs and a real provider; text-only entries are not proof of complete ordered resource operations.                                      |
| <a id="ed-01"></a> `ED-01`   | open     | Add a missing/disabled symbol-provider fixture.                        | Unavailable and partial results are truthful; unrelated provider data and uncaptured targets remain excluded.                                                 |
| <a id="ed-02"></a> `ED-02`   | open     | Certify one additional language-provider text edit.                    | Name provider/version; exact multi-file edits, shadowing, fresh selection, conflicts, and cancellation pass native checks.                                    |
| <a id="ed-03"></a> `ED-03`   | research | Evaluate an optional model-backed retrieval backend.                   | Specify local/remote data flow, licensing, resources, opt-in downloads, and auxiliary inference accounting before implementation.                             |
| <a id="ed-04"></a> `ED-04`   | open     | Add diagnostics navigation with a stale-document fixture.              | Open the exact current workspace file/range; changed or remote identities cannot be treated as fresh local locations.                                         |

### Retained Provider Acceptance Bounds

- `T-03-1`: compare indexed/fresh results across LF/CRLF, Unicode, case modes, TypeScript/Python, unsaved/saved edits, rename/delete, ignore changes, and interrupted rebuilds. Private/outside/symlink/binary/oversized cases stay refused or explicitly limited.
- `T-03-2`: freeze a 20-query TypeScript/Python fixture with ten nonliteral descriptions before changing the backend. Require the expected relevant file in the top five for at least 16/20 queries and 8/10 nonliteral queries; retain lexical/symbol controls, changed/deleted/unsaved-source cases, backend absence/error, privacy, and cancellation.
- `T-03-3`: retain limits of eight files, 1,000 edits, 1 MiB per file, and 4 MiB aggregate. Test native provider identity, shadowing, missing/disabled/ambiguous actions, stale/dirty/overlapping captures, private/outside targets, Stop, and exact Keep/Undo across reload. Interrupted batches report partial review, not atomicity.
- `T-03-4`: complete ordered resource-operation capture must precede mutation. Test create collisions, missing delete source, destination/alias conflicts, dirty/open targets, mixed text/resource edits, refusal, Stop, reload, and paired-operation Keep/Undo. Private fields or arbitrary callbacks are not an acceptable bridge.

## Tasks And Tests

| ID                             | State    | Atomic Task                                                       | Completion Check                                                                                                                                 |
| ------------------------------ | -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a id="t-02-1"></a> `T-02-1`   | open     | Extend task discovery/identity checks by one provider case.       | Duplicate labels and changed definitions remain distinguishable; freshly capture executable/args/cwd/env before consent.                         |
| <a id="t-02-2"></a> `T-02-2`   | open     | Add a failure/cancellation case to bounded owned task graphs.     | No leaf starts after failed/refused dependencies; sequential/parallel output belongs to exact approved executions.                               |
| <a id="t-02-3"></a> `T-02-3`   | research | Define explicit readiness for one prompt-owned background task.   | A declared matcher/signal distinguishes started/ready/failed/exited; silence is not readiness and Stop cleans descendants.                       |
| <a id="t-02-4"></a> `T-02-4`   | research | Document Test Explorer bridge feasibility.                        | Inspect stable API/cooperating extension identity/run/cancel/results; our own TestController or a CLI run does not prove cross-extension access. |
| <a id="task-01"></a> `TASK-01` | open     | Add a multiline diagnostic/output-overflow task fixture.          | Navigable failures retain exact ownership; truncation and unknown exit remain explicit.                                                          |
| <a id="task-02"></a> `TASK-02` | research | Evaluate one opaque task executor without broad execution grants. | Identify exact command and cleanup/consent metadata; if unavailable, publish the refusal reason and keep execution blocked.                      |

### Retained Task Acceptance Bounds

`T-02-2` admits at most four executable leaves, within existing command/concurrency/output caps. Validate the whole graph and each actual command before launch. Cover a single task, sequence, parallel leaves plus final dependency, cycle/missing/ambiguous dependencies, changed definitions, refused leaves, failed prerequisites, and Stop. No hidden launch after failure/refusal.

`T-02-3` must exercise ready-then-fail, exit-before-ready, malformed/absent signals, duplicate/late events, multiline diagnostics, overflow, and cancellation. Stop/disconnect/reload cleans only owned descendants and never restarts a watcher automatically. `T-02-4` research must address discovery, exact run identity, pass/fail/skipped/error, navigable failures, cancellation, and late/unrelated results through public APIs.

## Terminals And Command Authority

| ID                             | State    | Atomic Task                                                      | Completion Check                                                                                                                                          |
| ------------------------------ | -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="t-04"></a> `T-04`       | verified | Owned PTY output, human takeover, and process lifecycle cleanup. | [Terminal tests](src/test/terminal.test.ts) and [native lifecycle/privacy suite](scripts/terminal-lifecycle.mjs); no adoption of existing user terminals. |
| <a id="term-01"></a> `TERM-01` | open     | Add a hand-back/late-output race regression.                     | Human input and automation never overlap ownership; late output cannot reopen or retarget a retired terminal.                                             |
| <a id="term-02"></a> `TERM-02` | open     | Add one environment/quoting consent fixture.                     | Approved command/cwd/env exactly matches execution; inherited authority and secrets are not exposed in logs.                                              |
| <a id="term-03"></a> `TERM-03` | open     | Verify Rules/Ask/Allow All/YOLO transitions under cancellation.  | Stale picker/confirmation cannot elevate; URL/file permissions remain separate and only supported persistent modes are stored.                            |
| <a id="term-04"></a> `TERM-04` | research | Define a supported Windows shell execution contract.             | Specify quoting, environment, consent, PTY, process trees, and cancellation before claiming Windows support.                                              |
| <a id="term-05"></a> `TERM-05` | research | Evaluate opt-in OS sandboxing for one local platform.            | State enforceable filesystem/network/process limits and escape tests; never relabel the existing denylist as a sandbox.                                   |

## Remote-SSH

Remote-SSH is a first-class **planned workstream**, not currently certified. Do not assume that a local webview means local execution, credentials, storage, or browser ownership.

| ID                           | State    | Atomic Task                                                             | Completion Check                                                                                                                                    |
| ---------------------------- | -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="ssh-01"></a> `SSH-01` | research | Establish UI/extension-host/harness placement on a disposable SSH host. | Record actual host identities, supported VS Code APIs, workspace scheme, process placement, and transport; no private implementation bridge.        |
| <a id="ssh-02"></a> `SSH-02` | open     | Make remote OMP discovery/version failure actionable.                   | After [SSH-01](#ssh-01), distinguish remote PATH/version/auth failures; do not copy local credentials or auto-install executables.                  |
| <a id="ssh-03"></a> `SSH-03` | open     | Define remote workspace URI and canonical-path mapping.                 | Validate spaces, symlinks, casing, outside/private paths, and remote identity; never interpret a remote URI as a local filesystem grant.            |
| <a id="ssh-04"></a> `SSH-04` | open     | Exercise one remote file edit with Keep/Undo.                           | After [SSH-03](#ssh-03), verify exact remote bytes, dirty buffers, CRLF, conflict refusal, and no local file mutation.                              |
| <a id="ssh-05"></a> `SSH-05` | open     | Verify remote PTY ownership and Stop cleanup.                           | Remote descendants terminate; unrelated remote/local terminals survive; loss of transport cannot grant hand-back authority.                         |
| <a id="ssh-06"></a> `SSH-06` | open     | Scope remote sessions/journal/memory storage.                           | Separate host/root identities, owner-only modes, export/delete consent, and recovery; local state does not impersonate remote state.                |
| <a id="ssh-07"></a> `SSH-07` | open     | Add SSH disconnect/reconnect with a pending review fixture.             | No automatic generation/restart; preserve pending/accepted edits and conservatively refuse stale ownership.                                         |
| <a id="ssh-08"></a> `SSH-08` | open     | Verify one remote task and diagnostic navigation flow.                  | Fresh approved execution runs on the named remote host; output locations open exact remote documents.                                               |
| <a id="ssh-09"></a> `SSH-09` | research | Decide remote versus local browser/network execution semantics.         | Publish where URLs/data/processes go and how consent/cleanup works; no silent credential or port-forward sharing.                                   |
| <a id="ssh-10"></a> `SSH-10` | open     | Verify remote trust changes and cancellation.                           | Trust removal cancels owned work and clears authority; stale remote replies cannot change local/other-root state.                                   |
| <a id="ssh-11"></a> `SSH-11` | open     | Reproduce remote extension/native-addon installation prerequisites.     | Name remote arch/glibc/VS Code/OMP versions and package shape; refuse incompatible artifacts before starting tools.                                 |
| <a id="ssh-12"></a> `SSH-12` | blocked  | Accept one explicitly named Remote-SSH profile.                         | Complete applicable SSH rows and exact artifact/manual remote checks; publish remaining host/browser/transport exclusions, not blanket SSH support. |

## Workspaces And Platforms

| ID                         | State    | Atomic Task                                                 | Completion Check                                                                                                                               |
| -------------------------- | -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="ws-01"></a> `WS-01` | research | Define explicit multi-root selection and session ownership. | Specify cross-root context, review, execution, memory, and trust; no implicit union of filesystem permissions.                                 |
| <a id="ws-02"></a> `WS-02` | open     | Add root removal/reordering with pending work.              | After [WS-01](#ws-01), retire stale owners and preserve unrelated root processes, drafts, and bytes.                                           |
| <a id="ws-03"></a> `WS-03` | research | Specify virtual/read-only workspace behavior.               | Identify safe inspection APIs and unsupported mutations; do not coerce virtual URIs into writable local paths.                                 |
| <a id="ws-04"></a> `WS-04` | open     | Validate one additional Linux architecture or distribution. | Exact addon/browser/runtime loading and owned lifecycle checks pass; unsupported combinations remain explicit.                                 |
| <a id="ws-05"></a> `WS-05` | open     | Establish a macOS native fixture lane.                      | Name architecture/runtime; verify PTY, permissions, review, cleanup, and package licenses without paid inference.                              |
| <a id="ws-06"></a> `WS-06` | blocked  | Establish a Windows native fixture lane.                    | First define [TERM-04](#term-04); then test exact addon/shell/URI behavior and preserve unrelated processes.                                   |
| <a id="ws-07"></a> `WS-07` | research | Evaluate Dev Containers as a distinct host profile.         | Document mount identities, executable/storage placement, trust, permissions, and disconnect cleanup; SSH evidence is not container acceptance. |
| <a id="ws-08"></a> `WS-08` | open     | Add one newer supported VS Code/OMP compatibility lane.     | Name public API/parser changes and rerun focused/native exact-profile checks without silently widening the support matrix.                     |

## Platform Compatibility

Broader local OS/architecture support is a **planned contributor workstream**, not a universal-build claim. The current VSIX targets Linux x64 in its metadata and contains a native `node-pty` binary; terminal execution also explicitly rejects non-Linux hosts. Renaming the VSIX or removing that guard does not port it.

A package can cover multiple distributions or OS versions when its native dependencies and public runtime APIs are compatible. We do not need a build for every distro name, but we do need a measured compatibility baseline and a matching native build for each target. Start with one additional Linux x64 host, then tackle a named ARM64, macOS, or Windows target. See the [release baseline](RELEASE.md#supported-profile).

| ID                             | State    | Atomic Task                                                            | Completion Check                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="plat-01"></a> `PLAT-01` | research | Publish a source-backed platform dependency and build-baseline matrix. | Inventory native addon format/architecture, Node-API and system-library requirements, shell/process cleanup, paths, storage permissions, installed OMP and browser prerequisites. Separate known incompatibility, untested, and accepted profiles; include current Linux guards and package checks.                                                                                         |
| <a id="plat-02"></a> `PLAT-02` | open     | Test the unchanged Linux x64 release on one additional named distro.   | After [PLAT-01](#plat-01), record exact VSIX checksum, distro/architecture/libc, VS Code/Electron/OMP versions, native addon load, fresh install and owned lifecycle results. Record older-glibc or musl failures without assuming a minimum from the build-host version; supply evidence to [WS-04](#ws-04).                                                                               |
| <a id="plat-03"></a> `PLAT-03` | open     | Produce a reproducible Linux ARM64 development package.                | After [PLAT-01](#plat-01), pin the target/toolchain and native inventory; verify actual binary architecture, matching VSIX metadata and wrong-target refusal. Package creation alone does not close [WS-04](#ws-04) native acceptance.                                                                                                                                                      |
| <a id="plat-04"></a> `PLAT-04` | open     | Implement the missing host behavior for one named macOS architecture.  | After [PLAT-01](#plat-01), add the matching native runtime and scoped shell/path/process/storage behavior with refusal and cancellation regressions. Preserve existing Linux behavior and unsupported-host refusal; hand off native validation to [WS-05](#ws-05).                                                                                                                          |
| <a id="plat-05"></a> `PLAT-05` | blocked  | Implement the approved Windows host and native-runtime contract.       | First complete [TERM-04](#term-04) and [PLAT-01](#plat-01). Verify native dependencies, quoting/cwd/env, drive/UNC identity, process-tree Stop and storage access controls; preserve Linux regressions and complete [WS-06](#ws-06) before support claims.                                                                                                                                  |
| <a id="plat-06"></a> `PLAT-06` | open     | Add a reproducible build/package CI lane for one implemented target.   | After its applicable implementation task, pin the runner/toolchain and licenses; check native binary and VSIX target identity, hashes, exact installed addon loading and incompatible-host refusal on the actual target. Do not silently relabel Linux output or grant publication from PR CI.                                                                                              |
| <a id="plat-07"></a> `PLAT-07` | blocked  | Accept and document one additional downloadable target profile.        | After the applicable [WS-04](#ws-04), [WS-05](#ws-05) or [WS-06](#ws-06) native lane and [PLAT-06](#plat-06), use the [release gates](RELEASE.md#gates) for exact hosted bytes, fresh/update install, review, permissions, Stop and manual smoke. A maintainer approves target-specific acceptance/schema changes and publication; update the supported matrix only with reviewed evidence. |

Claim one row through [the issue workflow](#claim-a-small-task), using its stable ID and naming the target and deliverable. Existing `WS-04`/`WS-05`/`WS-06` remain the host-test tasks, not duplicate packaging assignments. Synthetic fixtures should not require credentials, paid inference, or browser/model downloads. Remote-SSH, containers, and other execution-host placement remain separate acceptance profiles.

## Model Providers

Broader OMP providers and local/custom endpoints are planned. A provider is a model/auth/transport backend; it is not the agent harness. Each provider needs its own public configuration and bounded conformance evidence.

| ID                           | State    | Atomic Task                                                             | Completion Check                                                                                                                                 |
| ---------------------------- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a id="prv-01"></a> `PRV-01` | research | Inventory pinned OMP provider discovery/configuration contracts.        | Name supported adapters, endpoint/auth fields, model catalog and feature flags; upstream availability is not Linewise certification.             |
| <a id="prv-02"></a> `PRV-02` | open     | Define explicit provider selection without a Copilot fallback.          | After [PRV-01](#prv-01), missing/malformed selection fails before generation; no automatic account import or fallback model.                     |
| <a id="prv-03"></a> `PRV-03` | open     | Add a synthetic OpenAI-compatible local endpoint fixture.               | Verify streaming, tool calls, cancellation, malformed replies, and disconnected endpoint with no live inference.                                 |
| <a id="prv-04"></a> `PRV-04` | open     | Add one named cloud-provider protocol fixture.                          | Pin documented protocol/version and synthetic responses; credentials never enter chat, webview, captured environment, or logs.                   |
| <a id="prv-05"></a> `PRV-05` | open     | Define provider capabilities in model/thinking controls.                | Unsupported images/tools/reasoning/context limits are disabled or refused, not synthesized from a model name.                                    |
| <a id="prv-06"></a> `PRV-06` | open     | Scope endpoint and credential configuration to explicit user authority. | Refuse workspace endpoint/secret overrides and unsafe accidental data routing; remote-host semantics are separately disclosed.                   |
| <a id="prv-07"></a> `PRV-07` | open     | Make usage/context reporting provider-specific and truthful.            | Missing token/cost/cache/reasoning fields remain unknown; auxiliary requests are accounted for when observable.                                  |
| <a id="prv-08"></a> `PRV-08` | open     | Add provider-switch session/history compatibility checks.               | Reject unsafe cross-provider resume; retain drafts, selected identity, immutable attachments, and review ownership.                              |
| <a id="prv-09"></a> `PRV-09` | open     | Verify one provider's edit/tool conformance cases.                      | Synthetic text/create/move/dirty/stale/refusal/Keep/Undo and Stop tests pass; opaque direct writes cannot bypass the journal.                    |
| <a id="prv-10"></a> `PRV-10` | blocked  | Certify one real non-Copilot model-provider profile.                    | Prior fixture/authority work plus separately approved finite live requests and exact native evidence; do not generalize to all models/endpoints. |

## Alternate Open Harnesses

The present implementation is OMP-specific. Harness neutrality is an architectural goal to investigate, not an existing plug-in SDK. A harness owns the agent loop/tools/history; changing it is more than changing a model endpoint.

| ID                           | State    | Atomic Task                                                         | Completion Check                                                                                                                                                |
| ---------------------------- | -------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="har-01"></a> `HAR-01` | research | Inventory the minimal harness adapter contract.                     | Identify stream events, tool requests, permissions, edits, questions, models, Stop, usage, and resume; list current OMP-specific assumptions.                   |
| <a id="har-02"></a> `HAR-02` | research | Assess Hermes as an explicitly identified candidate.                | Verify canonical maintained upstream/version/license and actual public CLI/API/protocol; record compatible and missing contract fields without auth/generation. |
| <a id="har-03"></a> `HAR-03` | research | Assess ZooCode or the intended upstream with that name.             | Resolve project identity and maintenance/license/protocol first; no invented repository or assumed ACP support.                                                 |
| <a id="har-04"></a> `HAR-04` | research | Assess a generic ACP-speaking harness against the adapter contract. | Public ACP conformance is necessary but not sufficient: test tool authority, edit capture, cancellation, sessions, and capability negotiation.                  |
| <a id="har-05"></a> `HAR-05` | open     | Extract one narrow adapter boundary with an OMP regression.         | After [HAR-01](#har-01), preserve existing behavior and strict ownership; do not build a generalized framework before a second concrete adapter needs it.       |
| <a id="har-06"></a> `HAR-06` | open     | Define host-mediated mutation for an alternate harness.             | External/opaque writes cannot be advertised as journaled review; unsupported edit routes refuse or disclose limits before execution.                            |
| <a id="har-07"></a> `HAR-07` | open     | Add a second-harness scripted transport fixture.                    | After selecting a researched candidate, normalize only known events; unknown capabilities fail closed and Stop cleans exact owned processes.                    |
| <a id="har-08"></a> `HAR-08` | open     | Bind persisted sessions to harness/version identity.                | Refuse incompatible history replay/migration; switching does not reinterpret review ownership, approvals, or provider credentials.                              |
| <a id="har-09"></a> `HAR-09` | research | Define explicit harness selection and capability presentation.      | Show unavailable controls and data/authority differences; no silent OMP fallback or workspace-provided executable grant.                                        |
| <a id="har-10"></a> `HAR-10` | blocked  | Accept one named alternate open harness profile.                    | Complete its researched contract, fixture, review, lifecycle, package/license, and exact native acceptance; real-model runs need separate allowance.            |
| <a id="har-11"></a> `HAR-11` | research | Define delegated-agent ownership and aggregate limits.              | Name process/tool/file authority, parent Stop, costs, and session identity before enabling delegation; child agents cannot bypass host consent.                 |
| <a id="har-12"></a> `HAR-12` | research | Define opt-in MCP import for one supported server contract.         | Explicit server/config/process/data/permission approval and cleanup; never import a user's MCP configuration automatically.                                     |

## Web And Browser

| ID                           | State    | Atomic Task                                                     | Completion Check                                                                                                          |
| ---------------------------- | -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| <a id="web-01"></a> `WEB-01` | open     | Add a consented redirect/privacy regression.                    | Each destination remains explicit; no hidden cookies/headers/credentials/body or silent localhost/network-sandbox claim.  |
| <a id="web-02"></a> `WEB-02` | open     | Verify missing/incompatible installed browser presentation.     | No automatic browser download; actionable failure and clean cancellation with no orphan process.                          |
| <a id="web-03"></a> `WEB-03` | open     | Add owned-tab failure/late-response cleanup checks.             | Stop/disconnect closes only owned pages; screenshot/read results retain exact page identity and privacy bounds.           |
| <a id="web-04"></a> `WEB-04` | research | Define optional existing-tab sharing without adopting accounts. | Establish public capability and explicit user/session consent; retain isolated browsing if safe ownership is unavailable. |
| <a id="web-05"></a> `WEB-05` | research | Evaluate one web-search backend.                                | Name provider/data/license/rate-limit behavior and opt-in authority; URL fetch is not indexed search.                     |

## Notebooks

| ID                         | State    | Atomic Task                                                         | Completion Check                                                                                                                   |
| -------------------------- | -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| <a id="nb-01"></a> `NB-01` | open     | Add one serializer-specific cell-source review fixture.             | Exact serialized bytes and dirty/live cell identity survive Keep/Undo; name the serializer/version.                                |
| <a id="nb-02"></a> `NB-02` | research | Establish safe structural cell-edit capture.                        | Ordered insert/delete/move metadata, output retention, dirty state, collisions, and review semantics are complete before mutation. |
| <a id="nb-03"></a> `NB-03` | research | Define opt-in kernel execution authority for one notebook provider. | Public run/cancel/results identities and kernel/data side effects are explicit; source review cannot promise kernel rollback.      |
| <a id="nb-04"></a> `NB-04` | open     | Add large/private image-output inspection boundaries.               | Bounded output metadata/provenance is truthful and private/oversized content is not automatically submitted.                       |

## Storage And Security

| ID                           | State    | Atomic Task                                                   | Completion Check                                                                                                                |
| ---------------------------- | -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| <a id="sec-01"></a> `SEC-01` | open     | Add one stale-owner/private-read/export regression.           | Canonical owner-only inputs and new-only exports reject symlink/race/private escapes without losing retained data.              |
| <a id="sec-02"></a> `SEC-02` | open     | Add retention/deletion cancellation coverage.                 | Confirmed plan matches exact current roots/sessions; stale plans refuse and protected recovery remains intact.                  |
| <a id="sec-03"></a> `SEC-03` | research | Define encrypted local storage for one explicit threat model. | Name key ownership/recovery/export limits and failure behavior; filesystem modes are not encryption.                            |
| <a id="sec-04"></a> `SEC-04` | research | Define portable session export/import compatibility.          | Distinguish inspectable export from resumable backup; validate schema, harness/provider identity, private paths, and authority. |
| <a id="sec-05"></a> `SEC-05` | open     | Add one webview message/CSP boundary regression.              | Unknown actions, stale owners, untrusted content, and unexpected network/worker routes cannot gain host authority.              |
| <a id="sec-06"></a> `SEC-06` | open     | Document one concrete host/process/network threat scenario.   | State enforceable boundaries and residual risks with a discriminating check, not universal security certification.              |

## Accessibility And Performance

| ID                             | State    | Atomic Task                                             | Completion Check                                                                                                                   |
| ------------------------------ | -------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| <a id="a11y-01"></a> `A11Y-01` | open     | Verify keyboard-only question/approval controls.        | Predictable focus, Escape/cancel, validation, and no hidden permission grant; record native environment.                           |
| <a id="a11y-02"></a> `A11Y-02` | open     | Verify review at narrow width and enlarged native zoom. | Hunk controls and file text remain reachable without incoherent overlap or lost focus; preserve fixed control geometry.            |
| <a id="a11y-03"></a> `A11Y-03` | open     | Verify high-contrast and light theme states.            | Changes/selection/disabled/focus states remain distinguishable without relying on color alone.                                     |
| <a id="a11y-04"></a> `A11Y-04` | open     | Perform one named screen-reader workflow audit.         | Record reader/OS/version and actual navigation/announcements; DOM labels alone are not certification.                              |
| <a id="a11y-05"></a> `A11Y-05` | open     | Add IME/Unicode composer and long-path layout fixtures. | Composition, submission, wrapping, selection, and draft restoration retain exact content.                                          |
| <a id="perf-01"></a> `PERF-01` | open     | Freeze one large-transcript responsiveness benchmark.   | Name fixture/environment and latency/memory budget; no secret transcripts or invented live model throughput.                       |
| <a id="perf-02"></a> `PERF-02` | open     | Measure one large-review rendering boundary.            | Stable scroll/focus and bounded resource use with exact review bytes; identify limits rather than claiming infinite-file support.  |
| <a id="perf-03"></a> `PERF-03` | research | Define localization/external string catalog boundaries. | Preserve command/settings identity, formatting and accessibility; decide RTL/IME acceptance before adding language support claims. |

## Collaboration And Release

| ID                             | State    | Atomic Task                                                    | Completion Check                                                                                                                                                                                  |
| ------------------------------ | -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="r-01"></a> `R-01`       | blocked  | Accept and publish the first exact artifact.                   | [Release contract](RELEASE.md): reviewed clean commit, hosted candidate, exact native/manual smoke, checksum-bound acceptance, and downloaded installation.                                       |
| <a id="doc-01"></a> `DOC-01`   | open     | Verify one README/build step from a clean checkout.            | Report exact prerequisites/commands and public links; no ignored dependency/profile can hide a setup gap.                                                                                         |
| <a id="doc-02"></a> `DOC-02`   | open     | Maintain one honest native visual comparison case.             | Synthetic task, actual versions/theme/viewport, source rights, PNG hashes, and scripted/recorded evidence are explicit.                                                                           |
| <a id="doc-03"></a> `DOC-03`   | open     | Reconcile one task/capability claim against its test evidence. | Preserve ID, link actual current checks, and split remaining sub-cases; no unsupported percentage-complete claim.                                                                                 |
| <a id="repo-01"></a> `REPO-01` | verified | Rename to linewise and align local repository bindings.        | [Policy](.github/release-maintainers.json) and [tests](quality/release.test.mjs) bind linewise and reject the old name; origin/API/history checked. New hosted checks remain [REPO-04](#repo-04). |
| <a id="repo-02"></a> `REPO-02` | blocked  | Enforce required main-branch checks/review.                    | Inspect actual GitHub protection/ruleset enforcement and fork-safe CI; unsupported private-plan settings remain launch blockers.                                                                  |
| <a id="repo-03"></a> `REPO-03` | blocked  | Configure private reporting and release environment reviewers. | Verify actual disclosure path and deployment protection/reviewer permissions; policy text alone is not enforcement.                                                                               |
| <a id="repo-04"></a> `REPO-04` | blocked  | Run new reviewed source through hosted/fork CI.                | Explicit commit/push authorization, read-only checks, full-history scan, and no credentials/model requests in PR jobs.                                                                            |
| <a id="repo-05"></a> `REPO-05` | blocked  | Approve a private-to-public visibility change.                 | [Readiness gates](docs/public-readiness.md), source/history/log/artifact review, settings enforcement, and explicit owner approval; not automatic artifact publication.                           |

## Keeping The Ledger Useful

IDs and row anchors are stable discussion links. A verified row must cite a current test, native runner, or bounded evidence document; repeatable code matters more than a historical checkmark. Mark research complete only when its decision and limits are documented, then add implementation IDs if appropriate. Keep provider, harness, platform, and release acceptance separate.

The public checker validates unique IDs, row states, explicit anchors, completion checks, and linked evidence. Detailed plans and issue discussion can grow around a row; private execution logs and personal-development diaries must not replace its concise shared contract.
