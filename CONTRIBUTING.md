# Contributing To Linewise

Linewise is an early alpha. Help us make agent coding inspectable, interruptible, and useful inside VS Code. Bug reports, documentation, accessibility feedback, reproducible tests, and focused code changes all help.

## Choose A Change

Start with the [roadmap](ROADMAP.md), [shared task ledger](TODO.md), and [capability matrix](PARITY.md). Choose an open/research ID, search existing issues for it, then ask to claim that exact slice in the issue. Use the ID in the issue title and PR, link its row, and let a maintainer confirm ownership and scope. Active claims/handoffs live in Issues, not an invented owner column in the ledger.

Open an issue before changing permissions, storage formats, supported hosts, runtime versions, or public tool contracts. For smaller fixes, describe the behavior and bring a focused pull request. Finish a task by updating its stable row with actual checks and remaining limits; do not mark a whole provider, harness, or platform complete because one fixture passed.

Use [Issues](https://github.com/qu-gg/linewise/issues) for reproducible bugs and proposals; use [Discussions](https://github.com/qu-gg/linewise/discussions) for questions and design exploration. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Development

Use Node 24.11+ (prefer Node 24 LTS), the committed lockfile, and the [development guide](docs/development.md).

```sh
npm ci
npm run check
npm run build
```

Press F5 to launch a development workbench and open a disposable fixture workspace. Native checks require the pinned local Linux VS Code/OMP profile and display prerequisites. They use scripted providers, not paid model generation. Ordinary development and CI must not require private credentials or model calls.

## Pull Requests

Fork the repository, create a topic branch, and open a pull request against `main`. Maintainers review and merge; contributors do not need direct push access. Keep one behavioral change per PR and avoid unrelated cleanup or lockfile churn.

Describe:

- What the user saw and the root cause.
- What changed and why that scope is needed.
- The regression test or other discriminating check.
- What actually ran, where it ran, and what remains unverified.

For UI work, include sanitized before/after captures from the actual affected surface. A browser fixture is not a native workbench; a scripted provider is not a real-model workflow. State versions, theme, viewport, and intentional differences when comparing interfaces.

Run the focused test first, then `npm run check`. Changes to shared lifecycle, review, permissions, or native adapters need relevant native acceptance before merge. A maintainer may perform that lane when your platform cannot; report the gap rather than claiming success.

## Engineering Boundaries

- Use public VS Code APIs and the pinned OMP/ACP contracts. Do not import private workbench or Copilot services.
- Keep filesystem mutation, consent, process ownership, and journal decisions in the extension host, not the webview.
- Preserve exact preimages, dirty-buffer/CRLF handling, stale-owner refusal, cancellation, and protected recovery data.
- Reuse existing modules/tests and keep changes within the [quality budgets](QUALITY.md). Do not lower gates or add blanket exceptions to make a change pass.
- Use synthetic fixtures. Never commit account data, credentials, private project content, sessions, or raw diagnostic/profile dumps.
- Do not run inference, inspect credential stores, publish artifacts, or alter another person's VS Code profile as part of routine verification.

AI assistance is welcome. The contributor must understand the result, verify it, check licenses and provenance, and accurately report tests. Passing tests do not substitute for reviewing a permission or data-flow change.

## Review And Credit

Maintainers make scope and merge decisions, especially at security boundaries. Required CI and review should be enforced through branch protection when the repository becomes public; until configured, they are policy, not an enforced second-person control. See [release policy](RELEASE.md) for separate publication authority.

Contributions are provided under the project's MIT license. Preserve existing notices and identify any third-party inputs. Git history credits contributors; additional display names or public acknowledgements should be opt-in, not inferred from private metadata.

Follow the [code of conduct](CODE_OF_CONDUCT.md). There is no guaranteed response time; keep reports actionable and discussions respectful.
