# Architecture And Design

Linewise's current [architecture guide](docs/architecture.md) owns module boundaries and core design constraints. [ROADMAP.md](ROADMAP.md) owns future work; [PARITY.md](PARITY.md) owns supported/partial/unavailable behavior; [QUALITY.md](QUALITY.md) and [RELEASE.md](RELEASE.md) own validation/distribution gates.

## Design Goals

- An independent OMP agent loop with a familiar, dense VS Code chat experience.
- Explicit context and inspectable host-owned approvals, never private Copilot services.
- Durable cumulative file review, exact selective hunk Keep/Undo, and conservative conflict/refusal behavior.
- Cancellation and process/recovery ownership before convenience automation.
- Bounded local state/search/tool operations with truthful provider-dependent and partial results.
- Public reproducible tests and contributor review without private credentials or paid model prerequisites.

The extension uses public VS Code APIs and ACP. OMP is a separately installed process; Linewise is not an embedded OMP SDK, Copilot Chat plugin, or implementation of Local's private working set. Independence from a harness release cycle does not remove VS Code API/runtime compatibility requirements.

## Non-Goals Of The Current Alpha

No OS sandbox, shell side-effect rollback, machine-state history rewind, arbitrary provider commands/file operations, remote memory, automatic OMP/browser downloads, imported MCP servers, delegated agents, persistent cross-turn services, notebook kernel execution, or full Local pixel parity.

Remote-SSH/multi-root/other-platform support requires explicitly scoped acceptance. Planned surfaces do not become supported because their wiring exists. Earlier private implementation ledgers remain in retained Git history; their evidence is not republished or silently promoted to current-source acceptance.
