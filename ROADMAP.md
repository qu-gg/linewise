# Linewise Roadmap

Linewise is a contributor-focused early alpha, not a promise of complete Local/Copilot parity. This is the short priority map. The [shared feature and verification ledger](TODO.md) owns stable, atomic task IDs and claim instructions; the [capability matrix](PARITY.md) describes the supported slice. Priorities below are work to validate or improve, not advertised features.

## Current Priorities

1. **Public readiness:** approachable docs, sanitized visual comparisons, private security reporting, fork-safe CI, and reviewed release authority. Keep source publication separate from artifact acceptance.
2. **Fresh-user onboarding:** clear missing/incompatible runtime and authentication errors, reproducible installation, and an honest first-run support matrix.
3. **Accessible control:** keyboard/focus/scrolling review at narrow widths, native zoom and high contrast, and separately reported assistive-technology testing.
4. **Reliable local workflow:** lifecycle, cancellation, review conflicts, storage recovery, and provider integration with discriminating regressions.
5. **Platform compatibility:** a dedicated [local OS/architecture workstream](TODO.md#platform-compatibility), starting with additional Linux x64 distributions, then matching ARM64/macOS/Windows builds and host behavior. Build success is not native or release acceptance.
6. **Remote and workspace coverage:** explicit [Remote-SSH tasks](TODO.md#remote-ssh) and multi-root ownership. Start with host/URI/permission decisions, then test file review, PTYs, reconnect, storage, and exact artifact acceptance; remote placement is separate from local platform support.
7. **Model-provider choice:** [provider selection and conformance](TODO.md#model-providers), including OpenAI-compatible local endpoints and named cloud adapters. OMP availability is not automatic Linewise certification.
8. **Open-harness interoperability:** [adapter contract and candidate research](TODO.md#alternate-open-harnesses), including Hermes, the intended ZooCode project, and ACP-speaking harnesses. Preserve review and host authority; do not assume a model-provider switch also changes the agent loop.

## Bounded Starter Tasks

| Area              | Useful First Contribution                                             | Acceptance                                                |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Onboarding        | Reproduce one fresh-install error and improve its actionable guidance | Focused regression and sanitized native capture           |
| Documentation     | Verify a clean-clone setup or fix an inaccurate capability statement  | Reproducible commands and no private links                |
| Accessibility     | Identify a keyboard/focus failure in review or the session manager    | Before/after behavior with theme, zoom, and viewport      |
| Provider edits    | Add a synthetic fixture for one supported provider text-edit case     | Exact bytes, stale/dirty refusal, Keep/Undo, cancellation |
| Storage           | Reproduce one interrupted or stale-owner recovery edge                | Preserved prior state and conservative refusal            |
| Platform research | Establish prerequisites and missing acceptance on a new host          | Clearly scoped evidence, not blanket certification        |

These are entry points, not the full inventory. Choose a stable ID in [TODO.md](TODO.md), link its row in an issue, and ask to claim that bounded slice. Issues own confirmed assignments and handoffs; no existing issue assignment is implied by this table.

## Platform Compatibility

The current download is a Linux x64 package with a compiled native terminal dependency and Linux-specific host behavior, not a universal JavaScript-only extension. We want contributors to expand that support deliberately, one named target at a time; it does not require a separate package for every distribution or OS patch version when native dependencies are compatible.

1. **Measure Linux compatibility:** inventory requirements in [PLAT-01](TODO.md#plat-01), then try the unchanged published VSIX on one additional distro in [PLAT-02](TODO.md#plat-02). Record exact package/runtime/libc versions and failures, not an assumed minimum from the build host.
2. **Implement a target:** [PLAT-03](TODO.md#plat-03) covers Linux ARM64 packaging, [PLAT-04](TODO.md#plat-04) a named macOS architecture, and [PLAT-05](TODO.md#plat-05) Windows after its shell contract. Preserve existing Linux behavior and unsupported-host refusal.
3. **Prove and publish the target:** add a reproducible [build/package lane](TODO.md#plat-06), complete the applicable native host tests, then seek [exact-artifact acceptance](TODO.md#plat-07). A matching filename, passing compile, or working chat view is not sufficient.

The [dedicated ledger section](TODO.md#platform-compatibility) owns task IDs, dependencies, completion checks, and claim instructions. No new platform is accepted by adding these tasks; contributors can start with one reproducible compatibility report without undertaking a whole port.

## Compatibility Dependencies

| Workstream          | First Decision                                             | Next Useful Slice                                                                         | Acceptance Gate                                                          |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Local platforms     | [PLAT-01](TODO.md#plat-01): native and host requirements   | [PLAT-02](TODO.md#plat-02): one Linux distro; then named target implementation            | [PLAT-07](TODO.md#plat-07): one exact hosted target/profile              |
| Remote-SSH          | [SSH-01](TODO.md#ssh-01): actual host placement            | [SSH-03](TODO.md#ssh-03): URI mapping, then remote review                                 | [SSH-12](TODO.md#ssh-12): one named remote profile                       |
| Model providers     | [PRV-01](TODO.md#prv-01): pinned public provider contracts | [PRV-03](TODO.md#prv-03): synthetic local endpoint                                        | [PRV-10](TODO.md#prv-10): explicitly authorized named live profile       |
| Alternate harnesses | [HAR-01](TODO.md#har-01): adapter/authority contract       | [HAR-02](TODO.md#har-02)/[HAR-03](TODO.md#har-03): candidate assessment, then one fixture | [HAR-10](TODO.md#har-10): one named harness/profile                      |
| Multi-root          | [WS-01](TODO.md#ws-01): explicit root ownership            | [WS-02](TODO.md#ws-02): root-change lifecycle                                             | Separate trust/review/process acceptance, not an implicit union of roots |

Independent research/docs/fixture tasks can be claimed separately. Cross-cutting changes to host authority, persistence, or mutation capture require a design discussion before implementation. There is no fixed provider/harness/platform delivery date and no implicit real-model budget.

## Explicit Gaps

- Remote-SSH, multi-root lifecycle, non-Linux platforms, and other VS Code/OMP versions need separate acceptance.
- Arbitrary OMP providers, alternate harnesses, delegated agents, imported MCP servers, and private Copilot services are not enabled.
- Test Explorer has no verified cross-extension stable bridge; native OMP-owned tasks are not that bridge.
- Existing browser-tab sharing, arbitrary provider commands/file operations, persistent cross-turn services, and notebook kernel execution are unavailable.
- OS sandboxing, shell rollback, encrypted local session storage, and machine-state conversation rewind are not implemented.
- Full pixel parity, broad screen-reader certification, and public artifact acceptance remain distinct gates.

## Milestone References

Historical IDs remain useful in commit discussions: T-04 terminals, UX-01 through UX-07 chat/review, V-01 lifecycle/history, V-04 instruction compatibility, T-03 retrieval/editor providers, T-02 tasks/tests, and R-01 release preparation. Their public successor rows and retained subtask IDs live in [TODO.md](TODO.md); private acceptance records remain private, and earlier full ledgers remain in Git history. New SSH, PRV, HAR, workspace, security, and accessibility categories extend rather than renumber that history. A completed bounded case does not certify its whole feature family.

The short-roadmap/detailed-checklist split is inspired by [PdfCraft's roadmap](https://github.com/storytold/pdfcraft/blob/main/docs/roadmap.md) and [parity assessment](https://github.com/storytold/pdfcraft/blob/main/docs/target-app-parity.md). Linewise's task definitions, evidence, and priorities are its own; no Craft code, brand assets, completion scores, or effort estimates are imported.

There is no fixed beta date. Beta requires reliable onboarding, a published and accepted artifact, exercised update behavior, clear security reporting, and a broader user-tested support matrix, not just a larger tool list.
