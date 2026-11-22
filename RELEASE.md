# Private Alpha Releases

## Scope And Ownership

`qu-gg` manually approves private GitHub prereleases from `main`. Ordinary pushes
are feature cuts, not publications. Keep the publisher `vs-omp-local`; increment
the package and lockfile version for each release and use the matching `vX.Y.Z`
tag. Never replace a released tag or its assets. Marketplace publication and
runtime bundling are separate decisions.

The initial acceptance profile is `local-linux-x64-single-root`: trusted local Linux
x64 filesystem workspaces, VS Code 1.146.0 and user-installed OMP 18.21.0. Node 24.11+
is required for release tooling. Remote-SSH, multi-root lifecycle, other platforms,
untrusted/virtual workspaces and other remote providers are not supported by this
profile. TODO3 remains open. Profiles are explicit evidence contracts: adding
remote support requires its own placement, authentication, storage, lifecycle and
workspace acceptance, not renaming or reusing the local result. Release packages
target `linux-x64`; another target requires explicit package and native acceptance.

## Release Gates

Every candidate requires locked installation, the complete deterministic check,
the unchanged all-dependency audit at moderate severity, a fresh build and VSIX
content/version/license inspection. The bootstrap permission for a red audit run
does not authorize a release. The picomatch advisory
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) was
withdrawn upstream on 2026-11-18; fresh full and production audits report zero
findings without dependency changes or suppressions. The audit remains a required
gate for every candidate and publication; do not use `npm audit fix --force` blindly.

Hosted candidate and preflight jobs pin Ubuntu 24.04, matching the accepted host's
glibc 2.39 baseline. A moving runner can produce a PTY addon requiring a newer
glibc even when Node-API is compatible. Changing this build baseline requires
fresh exact-package acceptance on the intended local host.

Local acceptance must run the full native release gate and extracted-VSIX tests
against the exact candidate commit and package checksum. Native tests use the
installed workbench/runtime and disposable fixture providers, not paid inference.
Do not copy OMP credentials, configuration or memory to GitHub runners. Upload
only the bounded release metadata, not local logs, screenshots or transcripts.

`check:release` alone does not include the audit or VSIX inspection. Source native
acceptance alone does not prove packaged installation or update behavior.

## Two-Phase Workflow

1. Manually request a candidate from the intended `main` commit. The read-only
   candidate job runs all hosted gates and uploads only the VSIX, checksums,
   candidate metadata and curated release notes. It creates no tag or Release.
2. Download that candidate into ignored local storage. Keep the checkout clean
   and at its recorded commit. Verify the checksum, run full local native and
   extracted-package acceptance, and perform the manual checks below. Record the
   result against the commit, VSIX SHA-256 and acceptance profile.
3. Manually approve publication using the successful candidate run and local
   acceptance record. Recheck the audit and candidate identity before granting
   write permissions. Publish those exact verified bytes as a private GitHub
   prerelease, never rebuild them in the write-enabled job.
4. Download the published assets, verify their checksums and install the downloaded
   VSIX in a clean disposable profile. A release is not fully exercised until
   downloaded-artifact acceptance passes.

Keep `main` at the candidate commit until approval. If it advances, create and
accept a new candidate. Only the publication job receives `contents: write`;
dependency installation, builds, tests and evidence validation stay read-only.
Manual evidence is an owner attestation, not a cryptographic proof or an enforced
second-person review. Pro-only repository protections remain deferred.

## Operator Commands

These commands become available after the owner commits and pushes the reviewed
workflow/tooling. No workflow has been dispatched as part of setup. The audit is
currently clear; any future audit failure stops candidate creation before packaging/upload.

```sh
gh workflow run release.yml --ref main -f phase=candidate
gh run list --workflow release.yml --event workflow_dispatch
```

Set `CANDIDATE_RUN` to the successful candidate run ID. Download into an empty
ignored directory; keep the acceptance JSON outside the candidate payload.

```sh
gh run download "$CANDIDATE_RUN" -n release-candidate -D .local-dev/release/candidate
```

After the manual checks below, run local acceptance from a clean checkout at the
candidate commit. The command checks the audit, runs the complete native release
gate and tests the extracted VSIX; it writes private new-only evidence only on
success. Use `--rollback=passed` only after a real compatible downgrade test. This
first release has no previous validated package.

```sh
npm run release:accept -- .local-dev/release/candidate .local-dev/release/acceptance.json --manual-smoke-passed --rollback=unavailable-first-release
```

Inspect the evidence before approving publication. Only fixed non-secret fields
are accepted; unknown fields fail validation. Evidence must never contain runtime
configuration, authentication, transcripts or arbitrary logs.

```sh
gh workflow run release.yml --ref main -f phase=publish -f candidate_run="$CANDIDATE_RUN" -f acceptance="$(node -p 'JSON.stringify(require("./.local-dev/release/acceptance.json"))')" -F approve_publication=true
```

Publication revalidates the candidate run, current `main`, exact bytes, license
texts, curated notes, audit and native evidence before its write-enabled job.
That job refuses existing tags, creates a draft prerelease, uploads the explicit
assets, downloads and byte-compares every asset, then publishes the prerelease.
A failed transfer leaves a draft for owner investigation, not an approved release.
Do not retry by overwriting assets or tags. After publication, download into a
fresh directory, check `SHA256SUMS`, and repeat clean-profile installation using
the downloaded VSIX before marking TODO7 complete.

## R-01 Authorization Testing Preparation

Preparation is not release approval. A preparation-only setup may verify installed
tools, rebuild development bundles, exercise deterministic release guards and
create private disposable workspaces/profiles. It must not commit, tag, freeze a
candidate, build/install a new VSIX, publish, import credentials or initiate model
inference without the corresponding authorization. Existing frozen rehearsals
must remain unchanged and must not stand in for current-source package acceptance.

The Linux acceptance runner probes Code through `/usr/share/code/bin/code`, its
public CLI launcher. An explicit `VSCODE_EXECUTABLE` override must likewise name
the public CLI, not the Electron application binary. The pinned OMP CLI reports
`omp/18.21.0`; acceptance stores its validated version as `18.21.0`.

Keep the setup under a new ignored `.local-dev/release/r01-authorization-*`
directory, with directories mode 0700 and files mode 0600. Give fresh-install and
update/rollback tests separate user-data, extensions and shared-data directories.
Use only owned fixture workspaces with known baseline files. An empty profile
does not establish installation/update acceptance. Development-mode testing of a
dirty checkout is source rehearsal only; `release:accept` still requires a clean
checkout at the exact hosted candidate commit.

Prepare a local runbook with source/runtime identities, prerequisites, test
commands, fixture paths and explicit pending authorizations. Leave the profile's
OMP executable locked until the intended scripted runtime or separately bounded
real-model test is authorized. Never copy a normal profile, OMP configuration,
memory or authentication into the setup. Native automated checks use existing
scripted providers and quiet owned displays; visible/manual testing is a separate
intentional action. Do not enable normal Copilot as a fallback.

| Test Area        | Required Check                                                                    | Acceptance Boundary                                                                        |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Installation     | Exact authorized test VSIX, clean disposable profile, publisher/version/checksum  | Pending until a current package is authorized; source launch is not installation           |
| Runtime/auth     | Missing executable, incompatible version, actionable auth error, explicit retry   | Scripted refusals first; real sign-in stays user-operated and secrets stay in the terminal |
| Command consent  | Ask/Rules, All/YOLO elevation, Allow Once, Skip, Escape, Stop and late reply      | No process without mode/rule consent, no late grant; YOLO deny/ask exceptions and reset    |
| File review      | Floating inline hunk Keep/Undo, file Keep/Discard and dirty-file refusal          | Preserve exact baseline and unrelated bytes; shell effects are not review rollback         |
| Ownership/reload | Stop, disconnect, reload/trust changes, persisted session/review                  | No stale callback, automatic resend, revived watcher or ownership transfer                 |
| Layout           | Desktop/narrow sidebar, keyboard focus and theme/zoom                             | Inspect real workbench; manual screen-reader/pixel equality remains separately scoped      |
| Update/rollback  | Exact new package over a compatible validated prior version in a separate profile | Do not treat the older frozen source rehearsal as a released rollback baseline             |

Only record observations actually performed. Do not prefill `manualSmoke`,
`native`, `packaged` or rollback success, and do not produce publication acceptance
JSON during preparation. Record unavailable-first-release rollback truthfully
where applicable. After owner-authorized candidate preparation, rerun the full
unchanged exact-artifact gates and manual checks before using `release:accept`.

## Manual Acceptance And Updates

### R-01 Non-Release Testing Checkpoint

Subsequent owner authorization permitted one current-source test VSIX and
installation only in two disposable profiles. The [testing receipt](reports/terminal-probe/r01-authorization-testing.json)
and [private runbook](.local-dev/release/r01-authorization-3K6HS1/RUNBOOK.md) record
actual results; the original setup/preparation and frozen cycle-sixteen receipts
remain unchanged historical records.

The test artifact is `vs-omp-local.vs-omp@0.0.2`, `linux-x64`, 3951046 bytes,
SHA-256 `2c5cf5f0e29c8eb3e42efa707be357ab2047d3e7e7a3ea61eb9e5c4f1b04bfe4`.
Both registry installations and all 131 packaged production files were verified.
The full source/native release-quality gate, all 12 crash/reopen cases, extracted
exact-VSIX workflows/reopen and full/production audits passed. The installed smoke
uses only public commands/UI, validates visible model controls, restores locked
runtime/Ask settings and preserves fixture bytes; it does not expose Test-only APIs.
Later harness/tooling changes do not change the verified packaged production bytes.

These are non-release test observations, not clean-commit hosted-candidate or
owner manual acceptance. Both installations were fresh; no update/rollback was
performed and no compatible validated released baseline exists. Physical desktop,
manual accessibility, real sign-in, candidate, publication and downloaded-artifact
acceptance remain pending. No Git write, new inference, normal-profile installation
or publication follows from this checkpoint. R-01/TODO7 stay open.

Use disposable trusted local workspaces and profiles. Check clean-profile VSIX
installation, runtime discovery, session/review persistence across reload, one
representative mediated write with Keep/Discard, and desktop/narrow-sidebar layout.
Exercise installing over the last validated version without changing the publisher
or extension identifier. Never use a user's working project as the release fixture.

Retain the previous known-good VSIX and its checksum. Test downgrade compatibility
in disposable storage before recommending rollback. Rollback means reinstalling a
previous validated package; it does not restore workspace files, conversations,
memory, credentials or external effects. Unsupported/future state versions must
remain non-destructive refusals. If no compatible previous release exists, state
that rollback is unavailable rather than promising it.

Record features, supported versions, exclusions, known issues and update/rollback
limits in the version's changelog entry. A failed gate leaves an unreleased
candidate, not a partially approved release. TODO7 remains in progress until a
complete private release and downloaded-artifact acceptance have been demonstrated.
