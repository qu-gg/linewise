# Linewise Release Policy

Linewise v0.1.2 is an early local-Linux preview. The matching GitHub tag/release records publication; no Marketplace distribution is approved. Public source preparation does not authorize a release, repository visibility change, model requests, or acceptance of newly changed bytes. Explicit maintainer launch approval remains subject to every gate below.

## Supported Profile

The current acceptance profile is `local-linux-x64-single-root`: trusted local Linux x64, VS Code **1.147.0**, separately installed/authenticated OMP **18.21.0**, and the tested host glibc baseline **2.39**. Remote-SSH remains unvalidated; multi-root lifecycle, other platforms/runtime versions/providers, untrusted/virtual workspaces, and broad accessibility coverage require separate evidence.

Candidate and preflight builds use **Ubuntu 24.04**, not a moving native-build baseline. The packaged node-pty Node-API addon still needs exact-host loading/native acceptance; a module ABI number alone is neither proof of compatibility nor a failure diagnosis. ELF/hash inspection does not independently certify every glibc symbol or Electron combination.

### Additional Platform Targets

The [platform compatibility workstream](TODO.md#platform-compatibility) owns planned expansion beyond this profile. `linux-x64` is both the VSIX target and the bundled native binary target; it is not merely an untested-host disclaimer. Another distro may use the same compatible artifact, while another OS/CPU architecture needs matching native dependencies and host behavior. Record actual system-library requirements rather than treating glibc 2.39 as a proven minimum or promising compatibility with musl.

Before adding a downloadable target, review its build/native inventory and licenses, exact VSIX metadata, installed OMP/browser prerequisites, shell/permission/path/storage behavior, owned process cleanup, and fresh/update/manual acceptance on that target. Current packaging and acceptance schemas are Linux-specific: extend them through a reviewed implementation PR that preserves strict existing checks, not by retagging a Linux VSIX or deleting platform guards. [PLAT-07](TODO.md#plat-07) requires a maintainer-approved target profile and the applicable release gates; a contribution or CI build does not itself authorize publication or change the current v0.1.2 download.

## Authority And Visibility

[.github/release-maintainers.json](.github/release-maintainers.json) pins the destination repository and approved GitHub logins. Changing it is a security-sensitive reviewed PR, not contributor self-enrollment. Hosted authorization requires both that allowlist and current repository `admin`/`maintain` permission, the exact current `main` commit, and explicitly selected `private` or `public` visibility. Private is the default; a visibility mismatch fails rather than silently publishing somewhere else.

The workflow is manual-only. Candidate/preflight jobs have read-only permissions; only publication receives `contents: write`. Fork PRs and arbitrary dispatch actors cannot authorize release. The `linewise-release` environment must have reviewed deployment protection before public publication. Naming an environment in YAML alone does not create an enforced second reviewer; verify actual settings. Where private-plan protection is unavailable, retain the limitation rather than claiming enforcement.

Local acceptance records the authenticated GitHub maintainer login in the legacy `owner` field. It is a checksum/commit-bound operator attestation, **not a cryptographic proof** of who clicked controls or of a second-person review. Human smoke and independent review must actually happen.

## Gates

1. Review and commit the exact source, version/lock roots, curated changelog, license inventory, native/browser pins, and sanitized public docs. Keep commits; do not bundle private evidence or rewrite history as a cosmetic rename.
2. On that exact current-main commit, dispatch **Linewise Release**, phase `candidate`, with the intended visibility. Locked install, complete deterministic/public checks, moderate audit, package build, and strict archive verification must pass. The bounded artifact has VSIX, checksum, candidate metadata, and curated notes only; no tag/release is created.
3. Download the exact hosted candidate. Inspect inventory/licenses/checksum, extract and run native tests, install into a fresh isolated workbench, and verify reopening/update behavior. Preserve the candidate bytes and failed evidence.
4. A maintainer performs actual desktop/narrow review and permission/Stop smoke on that exact artifact. A fixture runner cannot invent human approval. Record explicit rollback/scope acknowledgements and run official local acceptance from a clean matching checkout.
5. Dispatch phase `publish` with exact successful candidate run, bounded acceptance JSON, intended visibility, and explicit publication approval. Preflight rechecks current-main, actor/destination, candidate provenance, complete deterministic gate, audit, exact bytes/licenses, and all acceptance flags. Approval is an input, not authorization to skip those checks.
6. The protected publish job rechecks visibility/current-main/unused tag/checksum, creates a draft with only exact approved assets, downloads and byte-compares them, then publishes a prerelease. Perform a final install/smoke from the downloaded published VSIX before announcing support.

Any source/version/manifest/UI/runtime change invalidates previous-byte acceptance for a new release. Historical successful candidates must not be relabeled as Linewise acceptance. Do not upload raw model logs, profiles, private runbooks, crash dumps, or arbitrary generated notes.

## Operator Commands

Use Node 24.11+ and the pinned native runtime; never assert manual smoke unless it happened:

```sh
gh run download <candidate-run-id> --name release-candidate --dir reports/candidate
node scripts/release.mjs verify reports/candidate "$(git rev-parse HEAD)"
npm run release:accept -- reports/candidate reports/acceptance.json \
  --manual-smoke-passed --rollback=passed
```

`release:accept` requires a clean matching commit, actual branded CLI versions, a fresh dependency audit, the complete release/native/crash gate, and an extracted exact-VSIX native check. It writes a new-only mode-0600 attestation outside the candidate directory. It does not bypass or automate owner desktop smoke.

For v0.1.2, use `--rollback=passed` only after testing an update from the published v0.1.1 package. Do not claim a rollback test that did not happen; restoring an extension never restores workspace files, provider state, memory or external effects.

## Launch Checklist

Source publicization and artifact release are separate decisions. Before changing visibility, verify [public readiness](docs/public-readiness.md), hosted logs/artifacts, contributor paths, private vulnerability reporting, branch/environment protections, licenses, and explicit owner visibility approval. No current source version or historical private test is itself that approval.
