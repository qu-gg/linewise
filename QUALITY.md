# Repository Quality Gates

Use Node **24.11 or newer**, preferably Node 24 LTS (`nvm use`), and the committed npm lockfile. The newer Node requirement is for development analyzers, not the extension host or OMP process. Do not install the analyzers with Node 18. The shared runner launches child tools using the same interpreter as itself.

```sh
npm ci
npm run check
```

`check` fails fast on formatting, lint, strict type checks, quality-tool self-tests, fresh deterministic coverage, metrics/budgets, and architecture fitness. It does not rewrite files, update baselines, launch a model, install the extension, or touch a user's repository. Tests use disposable filesystem fixtures. VS Code's default Test task runs this command.

On this Linux machine, the VS Code executable also supplies a compatible Node runtime:

```sh
ELECTRON_RUN_AS_NODE=1 /usr/share/code/code scripts/quality.mjs check
```

## Commands

| Command                            | Purpose                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `npm run check`                    | Complete deterministic local/CI gate                                           |
| `npm run format`                   | Apply Prettier; review the resulting changes                                   |
| `npm run format:check`             | Check formatting without modifying files                                       |
| `npm run lint`                     | ESLint correctness/security rules; zero warnings                               |
| `npm run typecheck`                | Strict TypeScript, including unused locals/parameters                          |
| `npm test`                         | Existing deterministic tests and extension build                               |
| `npm run test:quality`             | Positive and adversarial tests of the gates themselves                         |
| `npm run test:coverage`            | Fresh source-mapped deterministic coverage                                     |
| `npm run metrics`                  | Complexity, size, CRAP and coverage-floor enforcement; requires fresh coverage |
| `npm run architecture`             | Import graph and safety-contract checks                                        |
| `npm run check:native`             | Installed-OMP, real workbench approval and extension-host checks               |
| `npm run check:release`            | Deterministic gate, then required native-host checks                           |
| `npm audit --audit-level=moderate` | Audit the locked development and runtime dependency tree                       |

The TypeScript 7 compiler remains the actual build/typecheck compiler, under the `typescript-compiler` npm alias. Static analyzers use the supported TypeScript 6 JavaScript API under `typescript`. Babel parses TypeScript for ESLint; it is not a substitute for the compiler's type checking. Browser JavaScript is linted, not TypeScript-checked.

## Metrics And Limits

Production TypeScript, tests, browser JavaScript/CSS, tooling scripts and root JavaScript configuration are measured. Generated output, vendored code, private spike output, JSON and Markdown are not code-size targets. CSS receives a file-length check only.

| Metric              | Default maximum | Definition                                                  |
| ------------------- | --------------: | ----------------------------------------------------------- |
| McCabe cyclomatic   |              10 | ESLint's classic `complexity` rule, per function            |
| Cognitive           |              15 | SonarJS `cognitive-complexity`, per function                |
| Function length     |        80 lines | Inclusive physical source lines, including declaration head |
| File length         |       500 lines | Physical source lines, excluding final newline              |
| Halstead volume     |          30,000 | File aggregate from typhonjs-escomplex-module               |
| Halstead difficulty |             150 | Same file-level profile                                     |
| Halstead effort     |       4,000,000 | Same file-level profile                                     |
| CRAP                |              30 | Per production function, using measured unit line coverage  |

Halstead uses TypeScript 6 type-erased ES2017 normalization before Babel/escomplex analysis. This makes modern syntax measurable by the older analyzer, but generated helper/lowered syntax contributes to the result. It is not a raw-TypeScript token count. The legacy analyzer has a deprecated development-only dependency; the separate packaging/architecture tooling also has an unresolved development-only audit finding. See [Toolchain Assessment](#toolchain-assessment). Replacement must revalidate fixtures and explicitly review baseline comparability.

CRAP is `C² × (1 − coverage / 100)³ + C`, where `C` is classic McCabe complexity. Unexecuted functions receive zero coverage, including files with synthetic empty coverage reports. Covered-line percentages are approximate function-local statement-line coverage, not branch/path proof. Anonymous callbacks are identified by declaration/ancestor names and occurrence, not line number; renaming or inserting similarly named callbacks may require explicit baseline migration.

## Coverage And Existing Debt

c8 includes **all production host and browser files**, not just imported files. Reports live in `reports/coverage/` (HTML, LCOV, JSON). Metrics and architecture JSON live in `reports/quality/`. Coverage goes through an isolated `.quality-build/`; source hashes, profile and coverage-report hashes must match before CRAP or coverage budgets can run. Stale, missing, malformed or non-finite evidence fails closed.

The deterministic profile now covers **98.98% of production lines** (6890/6961), up from 32.02%, with **255 application tests** and **18 quality-tool tests**. Native-host and browser visual acceptance checks remain separate evidence and are **not merged** into that number. V8's branch/function summary includes discovered instrumentation plus empty reports; do not mistake it for complete inventory of every unexecuted branch/function.

| Production File                                  | Enforced Line-Coverage Floor |
| ------------------------------------------------ | ---------------------------: |
| Webview (`media/main.js`)                        |                         100% |
| ACP transport                                    |                       98.61% |
| Host orchestration                               |                       98.99% |
| Host tool controller                             |                       99.72% |
| Approval controller/prompts/host adapter/Webview |                         100% |
| Private history bridge                           |                         100% |
| OMP guard                                        |                         100% |
| Review journal                                   |                         100% |
| Session state                                    |                       99.76% |
| Workspace adapter                                |                         100% |
| Gated terminal backend                           |                       99.02% |
| Storage inventory and inspection adapter         |                         100% |

The tests execute production source, not a copied implementation. Test-only module loaders supply VS Code and host transport boundaries; jsdom exercises Webview DOM behavior and sanitization; a separate official-SDK stdio fixture process exercises the actual ACP transport, including cancellation, fork identity, configuration, redaction and shutdown. None require OMP credentials or model calls. The executable transport fixture uses a POSIX shell and is supported on the Linux development/CI hosts. DOM tests are not layout/accessibility proof, and mocked host tests do not replace native-host validation.

The terminal backend has 17 real-process/SDK tests for approval, cancellation, cwd races, session ownership, limits, environment/argument isolation, timeout and process-group cleanup. Controller and host suites cover ownership, exact one-use permits, inline approval, stale connections, trust/root changes, Stop/disconnect/shutdown, unexpected exit, cleanup faults, permission modes/rules and native paired review. Four pure policy tests cover read-only composition, malformed/uncertain syntax, wrappers/environment, explicit deny/ask precedence and exact/prefix rules. Production now coordinates the explicit guard, ACP permission policy and Linux terminal capability. Service/async/PTY/extra shell input routes remain refused, with direnv and native background/service paths disabled. These tests do not establish remote/cross-platform support, sandboxing or containment of deliberately detached commands. Architecture still confines process ownership to the terminal adapter.

The required native/release gate runs four raw-ACP OMP 18.21.0 terminal probes and 15 installed native-parser scenarios covering range/insertion/block/register/multi-file edits, delete/edited rename, and stale/malformed/private-path refusal. Each native scenario uses a fresh broker token; successful mutations must be journaled and Discard must restore captured preimages. Partial multi-file failure reports completed operations, retains review state and stops before later files; it does not promise atomic rollback.

Nine real workbench cases now use installed OMP, the production guard/configuration, ACP and HostTools together: Skip, menu Escape, options dismissal, Allow Once, fresh rejection, cancellation before late approval, running-process Stop, disconnect and unexpected OMP exit. They render the production Webview card, verify actual size-theme tokens, command details/escaped bidi text, real markers/output and child-process removal, and preserve dirty buffers/review ownership. Playwright captures `reports/native-dialogs/` screenshots. The production-extension suite additionally validates native open-file delete/edited rename, stable review diffs, dirty-buffer refusal and Discard, plus all original history regressions.

Native permission acceptance additionally runs actual OMP commands for built-in read-only approval, an explicit allow, Allow All execution, deny under Allow All and an always-ask exception. Playwright drives the real picker, elevation warning, exception rejection and revocation. The companion registers the production settings schema and writes only its isolated user settings. Browser layout checks cover all modes at 280/320/440/720 pixels across dark/light/high-contrast themes; DOM tests cover the control's host messages and disabled states. This does not claim complete accessibility or Copilot screenshot parity.

VS Code suppresses dialogs under `--extensionTestsPath`, so the UI runner uses a test-only companion in a separate disposable development window, then runs the normal extension suite. It uses public APIs, dev-only Playwright and a dynamic loopback CDP port, with bounded deadlines/cleanup and no browser download or production debugging port. The companion is excluded from packaging. Source native checks use isolated package-shaped files without workspace dependencies. Evidence covers the installed Linux workbench, not OS-native dialog variants or Remote-SSH.

Anonymous V8 callback counters are retained through c8 reporting by naming otherwise omitted anonymous function records; counter values and ranges are never changed. Exported declaration boundaries are also accounted for when attributing function hits. Regression tests cover these mappings, zero-hit callbacks and unchanged evidence. This corrects false zero-coverage CRAP scores without awarding execution to uncalled functions.

TODO #2 acceptance adds deterministic stale/duplicate hunk identity, partial intent recovery, accepted-baseline, explicit context/isolation, task scope, FIFO failure/Stop, semantic focus and token-silent announcement checks. Installed production-host tests prove partial CRLF resolution, operation ownership, multi-snapshot selection/history replay, workspace `AGENTS.md` discovery and serialized/removed/stopped follow-ups. Browser checks exercise widths 280/320/440/720 and heights 560/800 in dark/light/high-contrast themes, including maximum attachments/queue content, visible composer actions, expanded hunks, keyboard Escape, retained focus and transcript scroll. Screenshots are inspected separately; this is not full populated Copilot parity or exhaustive assistive-technology certification.

Inline-approval acceptance additionally covers exactly-once and bounded FIFO decisions, busy-safe replies, immediate prompt ownership, abort/stale/duplicate responses, strict payloads, trust/deny changes, full file images, unavailable/disposed/replaced/reloaded views and failed Webview delivery. The original dock-layout checkpoint passed 128 maximum-content layouts across four widths, two heights, four theme variants, two font sizes and collapsed/expanded cards. The subsequent placement correction moves only command approvals into the scrolling conversation, outside collapsible activity; file approvals stay docked. DOM tests assert ownership of each location and no duplicates, and browser checks passed 16 command/file layouts at 280/320/440/720 by 560/800, including command-card scrolling, reachable decisions and composer Stop. All 158 deterministic tests, existing quality gates and nine native approval/lifecycle cases pass after this correction. Menu edges, streaming focus retention, Escape, larger-font long paths and screenshots were checked separately. Workbench zoom combinations and assistive-technology coverage are not exhaustively certified; broader chat-style parity remains separate.

TODO #4 local acceptance now includes actual hard-crash recovery and the phase/I/O matrix below, alongside populated compaction, summary-only future context, before/after edit/fork/root/reconnect boundaries, identical prompts, interrupted native turns and mixed Keep/Discard/create/delete/external-edit histories. Actual installed-OMP pre-tree hooks refuse edit/fork after mixed file review without replacement dispatch. No native evidence is counted as unit coverage.

### TODO 4 Fault Matrix

| Boundary                  | Required Evidence                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native hard crashes       | External `SIGKILL` of the actual extension host and OMP at `archive`, `intent-before`, `intent`, `navigation`, `navigated`, `verified`, `rewound`, `replacement`, `submitted`, `final`, `fork-save` and `fork-selected`.                                                                                                 |
| Recovery                  | New host reopens the same durable storage in the surviving workbench; exact files, actual dirty editor and review ownership survive. Complete originals/archives reopen, unfinished turns become cancelled, ambiguous prefixes refuse continuation, and provider captures prove no automatic request/replacement replay. |
| Compaction                | Generated persisted summary has a sentinel absent from original messages; native populated-summary failure/Stop preserves pending context/reviews and emits no success event. Unit checks retain previously reported cost and clear compaction UI even when its final save fails.                                        |
| Stop phases               | Broker startup, history capture, pre-send save, provider, cleanup and final-save. Pre-send cancellation sends nothing; already completed work is not rolled back or replayed. Startup cancellation remains explicitly unsupported and refuses safely.                                                                    |
| Storage and startup       | `ENOSPC`, `EIO`, `EACCES` during partial state write, atomic rename, configuration write, memory-settings query and pre-send save. Committed JSON is preserved, partial temporary files removed, ownership released and explicit repaired retry succeeds.                                                                |
| Combined failures         | Stop plus final-save failure for each I/O code; conservative reload cancels the last durable unfinished turn, preserves reviews and does not send anything. Existing approval/process cleanup-failure tests remain required.                                                                                             |
| Transport and credentials | Actual SDK stdio malformed JSON, 32 MiB frame overflow, abrupt exit/restart, missing/incompatible runtime and structured auth refusal. UI/status and transport logs redact fake credential markers while preserving login guidance.                                                                                      |

The crash companion observes production methods without replacing their behavior, blocks with `Atomics.wait`, and is killed externally before any catch/finally or deactivation can run. It is installed only in a disposable normal-workbench profile: a development-host window would itself close on host death and would not prove unsaved-editor survival. A new host reconnects through the public restart command. `scripts/history-crashes.mjs` emits `reports/history-crashes.json`; native/release gates always run all twelve stages, ignoring the optional manual subset filter. No test hooks or companion ship in the production package.

This completes the documented supported local Linux matrix, not every mathematical cross-product of faults. Injected I/O codes do not prove physical-disk exhaustion; process SIGKILL does not prove kernel/power-loss durability. OMP's internal memory database, remote hosts, other platforms/filesystems, detached processes and external side effects are not restored or certified by these tests. TODO #3 remains deferred. Historical file restoration remains a separate unimplemented feature.

### TODO 5 Storage and Retention

Inspection, explicit private export, confirmed session deletion, confirmed retention plans and conservative orphan cleanup are implemented. The [user-facing storage contract](README.md#storage-and-data-flow) defines lifetimes, budgets and exclusions. Inventory measures exact serialized host-state UTF-8 bytes, logical legacy-attachment text, retained review images and regular JSONL native artifacts, not total disk consumption. The storage inventory, artifact backend and inspection adapter each retain a 100% deterministic line-coverage floor.

Pure protection accounting covers active/running sessions, every review owner, recovery transitions/archives and dangling references. Revision-bound plans recheck eligibility inside the serialized state transaction. Serialization happens when each queued save executes: a previously queued save cannot resurrect a removed session, and failed removal rolls back before subsequent saves serialize. Native unlink happens only after the durable state commit; failure reports partial cleanup without pretending the session still exists. Unsent host snapshots and remembered Webview drafts are pruned from authoritative session membership, including after a missed message/reopened view.

Tests cover cancellation and host-operation exclusion, stale/replaced-host callbacks, age and size-pressure planning, unknown-age/protected retention, 128-item batch refusals, ambiguous legacy ownership, shared/recovery references, stale/recent orphan rejection, symlinks, traversal, changed file identity, invalid UTF-8 and a real replacement FIFO without blocking. Export write/sync failures for `ENOSPC`, `EIO` and `EACCES` remove the created partial output and permit repaired retry; unlink failure retains the artifact. A native-budget refusal proves zero provider requests. State-growth tests preserve committed state, allow shrinking oversized legacy data and retain explicit recovery paths.

The required production-extension suite executes `OMP: Inspect Storage` in actual VS Code, verifies a non-writable fresh virtual document and unchanged state without OMP. Confirmed export/deletion/retention flows use deterministic VS Code-boundary tests; they are not claimed as OS-native save-dialog or real-workbench destructive-click acceptance. Architecture negative fixtures prevent inventory/retention/policy domains from importing concrete host adapters, and process ownership remains confined to existing adapters, including test fixture subprocesses.

The 64 MiB state budget is a persistence growth guard, the 32 MiB native budget is pre-prompt admission/export control, and the 128 MiB export/4,096-entry scan/128-item batches bound individual maintenance operations. No silent eviction or per-write OS disk quota is claimed. Unknown-age or protected data may exceed planning targets. Export is non-resumable inspection JSON, not complete recovery backup. Checks assume private local host storage; metadata checks followed by unlink are not atomic against a malicious same-user process replacing paths. Neither power-loss durability, secure erasure nor restoration of workspace/memory/external effects is promised.

### Toolchain Assessment

The locked Halstead chain remains `typhonjs-escomplex-module@0.1.0 -> typhonjs-plugin-manager@0.2.0 -> babel-runtime@6.26.0 -> core-js@2.6.12`. The analyzer's latest published version is still 0.1.0, last modified in 2022. This deprecated development-only runtime is maintenance debt, not a production dependency. Retain the current normalized measurement profile and its known-value/modern-syntax fixtures rather than silently substitute a different analyzer. Any future replacement requires explicit normalization, score-comparability and reviewed baseline-migration evidence; no such migration or dependency churn is hidden in this checkpoint.

The locked development tree reports **five high audit entries** from the single `picomatch <=4.0.7` ReDoS advisory [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), propagated through `fdir`/`tinyglobby`/`@vscode/vsce` and `dependency-cruiser`. Published latest VSCE 4.1.1 and picomatch 4.0.7 provide no patched forward upgrade at this assessment. npm's proposed incompatible downgrades are not an acceptable blind fix. `npm audit --omit=dev` reports **zero production vulnerabilities**; that does not make the full audit clean. No audit suppression, ignored finding, lockfile change or workflow waiver was added. The existing all-dependency audit/hosted CI remains blocked until an upstream fix or separately reviewed compatible replacement is available. These tools currently consume trusted repository/package patterns, not arbitrary supplied globs; development dependency exposure still warrants review before publishing or processing untrusted inputs.

### Compatibility and Upgrade Policy

| Surface          | Verified Contract                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| VS Code          | Installed Linux 1.146.0; manifest minimum 1.146.0 is not certification of every newer release                       |
| OMP              | Exactly 18.21.0; supported/incompatible version probes, native guard/parser/history tests                           |
| ACP              | Protocol v1 through SDK 2.7.0; official-SDK stdio and installed-runtime handshake tests                             |
| Development Node | 24.11+; the complete DOM/tooling gate runs with Node 24, independently of extension-host runtime                    |
| Execution host   | Trusted local Linux filesystem workspace; remote, other platforms/providers and multi-root lifecycle remain TODO #3 |

Before widening any version range, require supported/missing/incompatible startup probes, strict compilation, analyzer known-value and modern-syntax fixtures, deterministic protocol/storage/review/history tests, the persisted-state/scale checks below, and the full package-shaped native release gate including all twelve real hard-crash stages. Run the existing browser theme/narrow-width checks when presentation changes. Do not weaken allowlists, metric defaults, existing coverage floors or fault stages to pass an upgrade. Actual Remote-SSH, authentication/storage placement and disconnect/reconnect acceptance must pass separately before claiming remote support; local credentials/memory must not be copied. Storage maintenance and shell execution explicitly refuse currently unvalidated remote/platform hosts.

Persisted host-state schema remains v1. A legacy fixture roundtrips optional missing history/model metadata, attachment aliases and pending CRLF review images without inventing native mappings; durable running turns reopen as cancelled. Unsupported v0/v2 state refuses without rewriting the original or leaving temporary output. There is no export importer. A future schema migration must be version-gated, preserve the original recoverable file, validate complete review/recovery references, commit atomically, and test interrupted/failed migration plus repeat/reopen behavior before removing legacy support. Never reinterpret an unsupported version as empty state or normalize away recovery data.

Scale smoke gates save/load/inspect/export a 5,000-turn, ten-session, approximately 10.9 MB state and render/rerender 500 Webview turns while preserving drafts, caret and the final prompt update. Each operation has a coarse ten-second regression ceiling. Uninstrumented local observations were approximately 27-64 ms for individual state operations and 0.25-0.30 seconds for DOM render/rerender; the latest instrumented DOM gate took approximately 0.85 seconds per render. These are environment-specific smoke evidence, not latency SLAs, memory profiling or large-transcript virtualization. Re-run these gates after storage/schema/render changes; profile and explicitly design pagination/virtualization before claiming substantially larger workloads.

### Remaining Debt

Metric exception entries have fallen from **44 to zero**, retiring all 14 entries present at TODO #5 kickoff without new exceptions, raised defaults, excluded production files or lowered coverage floors. Host orchestration now delegates operation ownership, activation/view adapters, startup, conversation transitions, prompting and presentation to focused modules. The host file is within the normal 500-line limit, with its floor raised from 94.07% to 98.99%. Webview context/events, state reconciliation and legacy fixture/test lengths are within default budgets. CSS was mechanically split with byte-identical minified output; this is not a frontend redesign. Toolchain audit exposure and the explicitly deferred compatibility/scale boundaries above remain visible, not hidden metric waivers.

`quality/baseline.json` records exact existing over-limit metrics and per-file coverage floors. Existing debt is visible, not evidence that these functions are sufficiently safe. New functions/files receive normal limits; new production files require at least 80% line coverage. Existing coverage may not fall below its recorded floor. Existing metric debt may not increase. Removed items, stale exceptions and exceptions now below the normal limit fail, prompting cleanup.

When a metric improves but remains over its default, **lower its exception maximum in the same change**. When coverage improves, **raise its floor**. These improvements still require review; the tool cannot infer a prior branch's baseline without Git history. After collecting fresh coverage, use the monotonic helper:

```sh
npm run test:coverage
node quality/metrics.mjs --tighten-baseline
```

Tightening removes obsolete/stale exceptions, decreases remaining maxima and raises coverage floors. It refuses metric regressions, new exceptions, reduced coverage, insufficient coverage in new production files, stale evidence and CI writes. It never runs automatically under `check` or CI. Review its diff. Do not loosen global defaults or exclude unsafe files to obtain green checks.

Initial recording and exceptional, reviewed migrations use this explicit command:

```sh
node quality/metrics.mjs --record-baseline 'A specific reviewed explanation of the accepted debt or measurement migration.'
```

This rewrites the complete baseline and can weaken gates, so review every changed maximum/floor and replace generic reasons with item-specific explanations for any newly accepted exception. It is forbidden when `CI` is set and is never called by `check`. Prefer a small manual baseline edit for a targeted improvement or migration. Gate/config/baseline changes need the same scrutiny as repository mutation code.

## Architecture Fitness

Dependency-cruiser includes type-only edges and NodeNext `.js`-to-`.ts` resolution. Rules reject cycles, unresolved imports (except the VS Code-provided `vscode` module), production dependencies on tests/tooling/dev packages, Webview access to host/core modules, domain-to-host inversions, concrete adapters in the review journal, history-to-review coupling, and process creation outside its owning host/transport adapters. ESLint prohibits dynamic imports and `require` in production code so those routes cannot silently hide from the graph.

AST contract tests restrict the review journal's filesystem imports to metadata-only `lstat`/`realpath`; mutations must pass through `TextFiles`. They also pin the approved OMP tool allowlist. Negative fixtures deliberately exercise illegal imports, cycles, direct-write/namespace/legacy-filesystem routes, and accidental enabling of shell-like tools. This is a regression tripwire, not a sandbox: deliberate policy rewrites, indirection or malicious dependencies still need review.

Existing behavior tests cover approval cancellation and retargeted symlinks, outside-root rejection, dirty-buffer conflicts, cumulative review/Keep/Discard, state recovery, context/history validation and ACP-mediated writes. Native-host tests additionally exercise real edit/fork history, unchanged workspace/review ownership, overlap rejection and cancellation.

## CI And Release Safety

The GitHub Actions `Quality Gates` job runs Node 24, `npm ci`, the same deterministic gate and an audit. Only the explicit metric and architecture JSON summaries are uploaded, even on failure when available; local reports, transcripts, screenshots and source-containing coverage output are not swept into artifacts. It uses no project secrets, paid models or self-hosted runners, and never autoformats or updates a baseline. Publishing the workflow does not itself protect a branch: after pushing to GitHub, configure repository rulesets to require this status check and review of safety-policy changes.

### Initial Repository Privacy Gate

The approved bootstrap target is private `qu-gg/vs-omp`, initially solo-maintained on `main`, with repository-local author `qu-gg` and a GitHub noreply address. The publisher/version remain `vs-omp-local`/`0.0.1`; this is not Marketplace registration or a release. MIT covers project-owned code, not the separate licenses in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). No externally supplied project source was declared.

Preserve working notes and unsanitized document copies only in ignored `.local-dev/`; Git ignores also exclude credentials, local databases, native JSONL, logs, build output, spike captures, reports, dependencies and VSIX files. Never force-add these directories. Filename exclusions do not detect an arbitrarily named sensitive export: inspect the exact index, scan its contents with a dedicated credential scanner and review personal paths/identifiers, URLs and non-source data before committing. Keep scanner results and review manifests local, never upload candidate contents to a scanning service. Repeat the checks whenever the staged tree changes; a clean scan is evidence, not proof of absence of private data.

The owner explicitly accepts a documented **red first hosted bootstrap run** if the unchanged audit step reports only the known upstream development findings in [Toolchain Assessment](#toolchain-assessment). This permission does not waive other failures, suppress the advisory, weaken metrics/coverage, authorize publishing or satisfy a green required check. The initial local checkpoint stops with the reviewed candidate staged, before any commit, remote creation or push. Hosted execution, actual private visibility and available private-repository protections must still be verified afterward. For solo maintenance, do not require an unavailable second-person approval; status checks and owner review remain separate controls.

Before a release, run `npm run check:release` with VS Code, a graphical display, the configured OMP executable, and the same authenticated model-discovery setup used for development. It must not be silently skipped on release. The native fixtures avoid paid inference but still require the local runtime and fixtures. Packaged-VSIX and desktop/mobile Webview acceptance remain additional release checks when their respective surfaces change; this suite does not automate browser visual coverage.

Metrics and architecture checks reduce regression risk; they do not prove repository safety. Keep the conversation-only history boundary, disabled unmediated mutation routes and pending-review ownership constraints until the corresponding behavioral tests and explicit design review justify a change.
