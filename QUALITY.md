# Repository Quality Gates

Use Node **24.11+**, preferably Node 24 LTS, and the committed lockfile. [Development](docs/development.md) covers setup; [CONTRIBUTING.md](CONTRIBUTING.md) covers review.

## Deterministic Gate

```sh
npm ci
npm run check
npm audit --audit-level=moderate
```

`check` requires Prettier, ESLint with zero warnings, strict TypeScript, quality-tool/release regressions, fresh deterministic coverage, metrics, and architecture checks. It does not contact a model, require provider credentials, or enable the live lane. Public documentation checks additionally reject missing/private link targets and unsafe collaboration/workflow configuration.

## Budgets And Baselines

Enforced defaults include cyclomatic complexity 10, cognitive complexity 15, function size 80 lines, file size 500 lines, and Halstead volume 30,000/difficulty 150/effort 4,000,000. The authoritative limits are in [quality/metrics-lib.mjs](quality/metrics-lib.mjs). Production coverage floors and reviewed reasons are recorded in [quality/baseline.json](quality/baseline.json); new production files require at least 80% lines.

Baselines are tighten-only. Fresh source/coverage hashes must agree; do not run metrics against old coverage, lower floors, raise defaults, add broad exclusions, or suppress a failed scanner to make a change pass. No blanket quality debt is accepted for a public launch. Test counts and measured coverage belong to each run, not a permanently hardcoded README claim.

Architecture rules in [.dependency-cruiser.mjs](.dependency-cruiser.mjs) and [quality/architecture.mjs](quality/architecture.mjs) keep protocol, policies, journal/state, host adapters, and webview ownership separate. Add an abstraction only for an actual ownership or complexity need.

## Quiet Linux Native Tests

```sh
npm run setup:test-display
npm run test:display
npm run check:native
```

The supported runner uses Xvfb, Openbox, and private D-Bus with isolated workbench data/extensions/workspaces. Setup uses configured signed APT indexes and extracts local display tools without sudo/system installation. Missing prerequisites fail; there is no implicit visible fallback. `VS_OMP_TEST_DISPLAY=visible` is an explicit potentially disruptive choice. [Development](docs/development.md#native-tests) explains host/runtime requirements.

Native gates retain real OMP/parser, public VS Code providers, actual approval/question controls, owned pipe/PTY/browser/task lifecycle, inline hunk review, notebook/image transport, history/storage/restart, and all twelve hard-crash/reopen stages. Required gates cannot inherit a narrowed manual crash-stage filter. Fixture companions and observers are excluded from production VSIX files.

Scripted providers must refuse real-provider fallback. A disposable workspace/profile/display is **not an OS sandbox**. Do not import user credentials/settings, interfere with unrelated processes, or use authentication retries to satisfy a test.

## Live Model Acceptance

Real-model checks are opt-in and separate from fork CI/native acceptance. Agree on exact model/provider, finite request/tool/token/time/run budgets, observation of auxiliary generation, and stop-on-failure policy before starting. Reports remain private; no absent observer or missing hook proves zero requests. Never convert an exhausted attempt into an implicit retry.

Provider models and compaction can consume account entitlements. A successful bounded scenario does not certify every model/provider, unobserved auxiliary work, full Local parity, or a new artifact. Keep current-source and historical/exact-VSIX results distinct.

## Collaboration And Publication

Fork CI runs under read-only permissions, does not use `pull_request_target`, stores no provider secrets, and publishes no VSIX. Actions are SHA-pinned; caches and curated metric reports are not authorization inputs. Maintainers review permission/storage/runtime/quality/workflow changes and merge PRs according to [CONTRIBUTING.md](CONTRIBUTING.md).

Main branch protection, private vulnerability reporting, and required reviewers for the `linewise-release` environment are launch settings gates. A policy written here is not a claim that GitHub has enforced it; verify the actual repository settings before public launch. [RELEASE.md](RELEASE.md) defines exact-artifact acceptance and narrowly scoped write authority.

## Toolchain Assessment

Use the pinned compiler/analyzer/native/browser runtime contracts and full audit gate. A withdrawn advisory or zero advisory count is not a general security certification. Review transitive overrides and preserve actual license notices and exact bundled-runtime inventory. Do not compare bundled production bytes immediately after raw `tsc`; rebuild first.
