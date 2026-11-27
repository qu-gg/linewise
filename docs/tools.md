# Tool Contracts

The explicit enabled set is `read`, `write`, `todo`, `retain`, `recall`, `memory_edit`, `edit`, `bash`, `editor`, `ask`, `browser`, `rename`, `task`, `fetch`, `code_action`, and `notebook_edit`. Unknown/delegated/MCP routes are disabled. Actual strict schemas and host validation are authoritative; this guide summarizes limits, not permission to bypass them.

## Files And Review

`read` admits regular files/directories in the selected workspace tree without an extension allowlist, including native line selectors. Outside canonical targets require one-time consent; private control storage, device/special files, and non-filesystem URI reads are blocked. Broad reads do not broaden mutation permission or sandbox commands.

`write` creates/replaces supported UTF-8 text; native `edit` uses captured pre/post images and a prompt-scoped acknowledged broker. Linewise pins OMP's `edit.mode` to `hashline` for the child process so `read` returns line-addressed snapshots and `edit` anchors. A recoverable validation rejection keeps the read snapshot, matching the documented retry; only session changes and unexpected adapter failures discard it. Deletes and paired moves require exact preimages, clean sources, and absent destinations. Binary/BOM/oversized/unsupported text and executable-bit mutations are refused. Dirty notebooks block generic serialized-file mutation.

Journal operations are not atomic multi-file transactions. Completed/interrupted operations remain reviewable after later failure. Keep/Undo/Discard revalidate actual content and refuse newer user/external changes. Save participants may produce a conflict rather than silent recorded-result drift.

## Editor And Provider Operations

`editor` provides literal/glob discovery, diagnostics, symbols/definitions/references, task metadata, and live notebook text/images through public VS Code APIs. Positions are 1-based; ordinary results cap at 100 and 64 KiB. Private/outside results are filtered; provider absence/partial coverage is explicit.

Root-owned lexical search includes fresh unsaved overlays and project ignores with private/vendor/build exclusions: 256 candidate files, 1 MiB/file, 4 MiB total, 100 results. Explicit `local-lsa-v1` retrieval uses corpus TF-IDF/SVD, not pretrained embeddings: 64 files/1 MiB text/512 terms/32 dimensions/16 MiB derived snapshot/10-second build. No context is implicitly attached, runtime downloaded, inference invoked, or index persisted.

Workspace symbols require a nonblank query up to 200 characters, inspect at most 1000 provider entries, and filter canonical locations. Provider ranges can cover declarations rather than identifier spans. Empty results do not prove absence; Stop releases waiting without promising cancellation of provider computation.

`rename` uses the installed provider at a 1-based position with explicit `paths` capturing one to eight saved canonical workspace files, including source: 1 MiB/file, 4 MiB captured, at most 1000 edits. Dirty/stale/uncaptured/outside/private targets, overlapping edits, snippets, commands, and resource operations are refused. Discover references and read files first; provider absence is not a textual fallback.

`code_action` lists up to 32 resolved actions for quickfix/refactor/organizeImports/fixAll, then applies an exact fresh unambiguous title with an explicit range and the same captured-file bounds. Provider commands are ignored, never forwarded; command-only/unresolved/disabled/mismatched actions are unavailable. Text-only application is partial provider semantics, not complete refactoring parity. Applied/interrupted multi-file edits remain reviewable.

## Tasks And Commands

`bash` mediates actual command/cwd/environment and owned processes. Pipe/PTY and hidden/background/foreground visibility are independent. Four retained/pending commands and bounded output remain; default approval/execution waits are unlimited. Positive explicit foreground timeouts cap at 120 seconds after consent. Managed jobs belong to the prompt; no detached/background shell workaround grants persistent services.

`task` selects an exact canonical-root name/source and captures concrete process/bash execution; an optional OMP-owned graph has one to four nodes. Whole-graph recapture and consent precede launch; declared prerequisite readiness is an exact complete line. Failure blocks dependents. This is not the provider's scheduler/problem matcher. Dirty text/notebook autosave preflight refuses known dirty execution unless the existing `task.saveBeforeRun` is `never`; production never changes that setting.

Optional `json-lines-v1` diagnostics accept at most 32 bounded current-source canonical workspace failures with positive 1-based locations. Invalid/truncated/outside/stale rows are rejected. Opaque/custom executors/shells, quoting objects, unresolved variables, persistent watchers, Test Explorer and model stdin/secret input are unavailable.

Commands/tasks are unsandboxed. Process cleanup cannot undo filesystem/network effects or contain deliberately detached groups. Human takeover suppresses future model capture for that execution; it is not secret erasure.

## Questions And Web

`ask` offers up to four bounded questions with choices, multi-select, optional free text and dismissal. Answers are prompt-scoped, not authority or credentials. Stop/ownership retirement closes input; never invent a dismissed or unavailable answer.

`fetch` reads one HTTP(S) GET with independent one-time consent for every exact URL/redirect, up to four redirects and 256 KiB streamed bytes/40,000 decoded characters. Credentials/alternate schemes, supplied headers/cookies/body/referrer, binary responses, rendering/subresources, and automatic retry are absent. HTML is untrusted source. Consent can authorize internal/local hosts; GET may have effects. Stop cancels transport; no automatic elapsed deadline is configured.

`browser` owns up to four isolated Playwright page handles with bounded text/control reads, CSS single-element interaction, viewport/navigation/history, last-64 console messages and actual viewport PNGs up to 512 KiB. Exact consent is independent of command elevation. Same-owner pages/site/background network state can persist across completed prompts until revoked. Existing profiles/tabs, CDP attachment, arbitrary JavaScript, file URLs, upload/download, cookie access and password-field interaction are not exposed.

## Notebooks And Memory

`editor notebook` reads live cells/text output, optionally starting at a 1-based cell: 8000 source characters/cell, 8000 text-output bytes/cell, 2000/item, up to eight outputs/eight items. Indexed `notebookImage` returns one current signature-checked PNG/JPEG/WebP output up to 512 KiB as a real model image. HTML/SVG and other binary rendering are unavailable.

`notebook_edit` replaces one saved nbformat-4 cell source using exact fresh `expectedSource`, serialized-text journal review, strict unambiguous UTF-8 JSON up to 1 MiB/1000 cells, preserving other serialized values and high-precision metadata. Dirty/stale/outside/private/alias/unchanged targets are refused. Existing output may be stale; no kernel execution, output clearing, cell insertion/deletion or universal serializer certification follows.

`todo` reports the agent plan; `retain`, `recall`, and `memory_edit` use supported local OMP memory. Default per-project Mnemopi uses full-text retrieval with `llmMode: none`, no remote extraction. Existing supported local backend configuration can have its own upstream data flow. Remote memory backends are refused; user configuration is not rewritten. [Security](../SECURITY.md) explains sensitive storage and shared-history limits.
