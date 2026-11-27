# Developing Linewise

## Prerequisites

- Node **24.11+**, preferably Node 24 LTS; `.nvmrc` selects Node 24.
- npm and the committed lockfile.
- For native acceptance: Linux x64, **VS Code 1.147.0**, **OMP 19.2.1**, and disposable trusted single-root workspaces.
- For owned-browser tests: an installed compatible Chromium browser. The extension does not download one.

```sh
npm ci
npm run check
npm run build
```

`npm run check` performs formatting, lint, strict types, quality-tool self-tests, fresh deterministic coverage, complexity budgets, and architecture checks. It does not require credentials or paid inference. See [QUALITY.md](../QUALITY.md).

Press F5 to open a development workbench. Open a disposable fixture folder and run **Linewise: Open Chat**. Keep development user-data/extensions/workspace directories separate from your everyday profile. Do not import real logins or private settings into fixtures.

## Updating The OMP Pin

`src/omp-version.ts` is the single runtime source of truth. `OMP_TESTED_VERSION` is the exact release-acceptance pin; `OMP_MINIMUM_VERSION` and `OMP_MAJOR` define the forward-compatible runtime window. A user may run a newer patch/minor within the tested major without a Linewise update; release acceptance still requires the exact tested build.

1. Download and verify the new Linux x64 OMP release. Run its ACP spike before changing pins:

   ```sh
   OMP_EXECUTABLE=/path/to/omp npm run check:native
   ```

2. Update `OMP_TESTED_VERSION`, `OMP_MINIMUM_VERSION`, and `OMP_MAJOR` in `src/omp-version.ts`. Raise the minimum only when older releases are known to break.
3. Install the matching native package, which is released in lockstep with OMP:

   ```sh
   npm install --save-exact @oh-my-pi/pi-natives@<omp-version>
   ```

4. Update the current-profile lines in `README.md`, `RELEASE.md`, `docs/development.md`, `CHANGELOG.md`, and the `omp.executablePath` description in `package.json`. Leave historical changelog entries and image provenance untouched unless those artifacts are regenerated.
5. Run `npm run check`; it runs `scripts/version-check.mjs`, which rejects stale package, lockfile, current-profile docs, and hardcoded source versions. Then run `OMP_EXECUTABLE=/path/to/omp npm run check:native`.

## Useful Commands

| Command                                                                   | Purpose                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `npm test`                                                                | Deterministic application tests and build                    |
| `npm run typecheck`                                                       | Strict types without emitting files                          |
| `npm run test:quality`                                                    | Quality/release-tool regressions                             |
| `npm run check`                                                           | Complete deterministic gate                                  |
| `npm run setup:test-display`                                              | Prepare isolated Linux display tools locally                 |
| `npm run check:native`                                                    | Installed-runtime/native workbench acceptance                |
| `npm run check:release`                                                   | Deterministic plus required native/crash acceptance          |
| `npm audit --audit-level=moderate`                                        | Full development/runtime dependency audit                    |
| `npm run build`                                                           | TypeScript compilation followed by bundled production assets |
| `npm run package -- --target linux-x64 --out linewise-dev-linux-x64.vsix` | Development VSIX, not an accepted release                    |

TypeScript 7 is the build compiler under the `typescript-compiler` alias. Analyzers use the supported TypeScript 6 JavaScript API under `typescript`. Use the same supported Node interpreter throughout a gate. Running the compiler directly can overwrite bundled guard output; run the full build before packaging or production-byte comparisons.

## Native Tests

On Debian/Ubuntu Linux x64:

```sh
npm run setup:test-display
npm run test:display
npm run check:native
```

The setup downloads/extracts display tools into ignored local storage using existing configured signed APT indexes; it does not use sudo or install system packages. Other Linux distributions must provide Xvfb, xvfb-run, xauth, Openbox, D-Bus, wmctrl, and xdpyinfo themselves.

Linux native tests default to a private Xvfb/Openbox/D-Bus session. Missing prerequisites fail rather than falling back to the real desktop. This is display/session isolation, **not an OS sandbox**. Only `VS_OMP_TEST_DISPLAY=visible` explicitly requests visible tests, which may interrupt the desktop.

Set `VSCODE_EXECUTABLE` to the public VS Code CLI launcher if it is not in the runner's default location. Set `OMP_EXECUTABLE` for test runners that support an alternate pinned OMP path. Use `omp.executablePath` in the isolated workbench's user settings for ordinary extension setup; do not change shared user settings.

Required native gates retain installed OMP/parser checks, actual approvals/questions, terminal/browser/task ownership, inline review, and all twelve hard-crash/reopen stages. Scripted fixture generation is separate from real-model acceptance. A virtual display does not certify physical desktop behavior, hardware rendering, OS notifications, or screen readers.

## Visual Inspection

`node scripts/preview.mjs` serves a browser fixture using built production assets and mocked host messages. It does not run an agent or certify native workbench integration. `PORT` chooses an unused loopback port. Native captures must come from owned disposable workbenches; public docs must label the producing surface and use sanitized synthetic content.

Do not substitute private historical screenshots for fresh evidence of changed production assets. [ATTRIBUTION.md](../ATTRIBUTION.md) and [SECURITY.md](../SECURITY.md) describe provenance/privacy requirements.

## Model Calls And Releases

Live tests and spikes are opt-in and can use account entitlements. They are never prerequisites for ordinary fork CI. Before a real-model run, agree on the exact provider/model, scenario, finite request/tool/token/time/run limits, observation, and failure policy. Do not infer zero generation from a missing observer or reopen exhausted budgets.

Never inspect credential stores, copy OMP authentication into profiles/runners, silently switch to a real provider, or run inference to make a screenshot. Compaction may itself generate provider requests.

Public source changes do not publish a VSIX. [RELEASE.md](../RELEASE.md) requires clean-commit, hosted-candidate, exact-byte/native/manual acceptance and downloaded-artifact verification. Contributor PRs must not publish or receive maintainer credentials.
