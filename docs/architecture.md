# Linewise Architecture

OMP owns the agent loop/provider/session implementation. Linewise owns public VS Code integration, explicit context, host consent, tool mediation, process lifecycle, durable file review, and presentation. The separately installed `omp acp` process communicates over ACP stdio; the extension does not embed OMP's Bun SDK or read private Copilot credentials/services.

## Ownership

| Layer                 | Examples                                                                                                       | Responsibility                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Extension composition | [extension.ts](../src/extension.ts), [host-view.ts](../src/host-view.ts)                                       | Public commands, lifecycle, adapter ownership                              |
| Protocol/runtime      | [omp-guard.ts](../src/omp-guard.ts)                                                                            | Pinned allowlist and mediated OMP capability routes                        |
| Host tools            | [host-tools.ts](../src/host-tools.ts)                                                                          | Validated dispatch and consent, not webview authority                      |
| Command policy        | [terminal-policy.ts](../src/terminal-policy.ts), [host-permissions.ts](../src/host-permissions.ts)             | User-only literal rules and revocable workbench-window elevation           |
| Process ownership     | [terminal.ts](../src/terminal.ts)                                                                              | Owned command capture/limits/cleanup, unsandboxed host effects             |
| Workspace review      | [workspace.ts](../src/workspace.ts), [review-hunks.ts](../src/review-hunks.ts)                                 | Journaled exact preimages and selective accepted baselines                 |
| Review presentation   | [review-presentation.ts](../src/review-presentation.ts), [inline-review-view.ts](../src/inline-review-view.ts) | Editable proposal surface, overview navigation, and stale-owner validation |
| Storage               | [storage-files.ts](../src/storage-files.ts), [state.ts](../src/state.ts)                                       | Bounded private state/artifacts and conservative recovery                  |
| Chat/webview          | [chat-view.ts](../src/chat-view.ts), [media/main.js](../media/main.js)                                         | Presentation/messages, never filesystem or approval authority              |

## Mutation And Consent

The host captures exact canonical text and ownership, asks when an operation needs consent, revalidates after the await, records durable intent, applies the supported change, and acknowledges it into the review journal. A stale response, owner, path, dirty buffer, or preimage refuses mutation. Partial multi-file application is visible and recoverable, not advertised as an atomic transaction.

Webview actions send validated opaque owner/action IDs, not replacement paths, commands or grant scopes. Approvals resolve once and remain separately reachable while a tool is pending. Stop/reset/disconnect/history/trust changes retire authority before late results can act.

Keep advances only the selected accepted baseline; Undo restores only the pending hunk. Monaco is a readonly presentation surface; mutation remains in the host journal. Creation/deletion/moves preserve operation ownership rather than arbitrary text-only splitting.

## Lifecycle And Persistence

One active OMP process/session per window simplifies ownership. Prompts/history/configuration/review operations are serialized, with bounded explicit follow-up queues. Cancellation closes pending host work and owned processes; unrelated tasks/terminals/tabs remain untouched.

State writes are bounded/atomic with Linux private modes. Active, pending-review and interrupted-history recovery owners prevent deletion. Export is inspectable data, not resumable backup. Conversation navigation does not roll back files, buffers, shared memory or external state.

## Test And Distribution Boundary

Deterministic tests exercise local contracts; native fixtures use public workbench/provider controls and the actual pinned runtime without real inference. Test companions/observers and source maps are excluded from the strict VSIX inventory. Real-model acceptance is separately observed and budgeted. Exact-byte release acceptance cannot be borrowed from old source or screenshots.

See [tools](tools.md), [quality](../QUALITY.md), [security](../SECURITY.md), and [release policy](../RELEASE.md) before widening an ownership boundary.
