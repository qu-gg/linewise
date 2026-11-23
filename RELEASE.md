# Linewise Release Policy

Linewise is an early alpha. **0.0.2 is currently unpublished**, and no Marketplace distribution is approved. Public source preparation does not authorize a release, repository visibility change, model requests, or acceptance of newly changed bytes.

## Supported Profile

The current acceptance profile is `local-linux-x64-single-root`: trusted local Linux x64, VS Code **1.146.0**, separately installed/authenticated OMP **18.21.0**, and the tested host glibc baseline **2.39**. Remote-SSH remains unvalidated; multi-root lifecycle, other platforms/runtime versions/providers, untrusted/virtual workspaces, and broad accessibility coverage require separate evidence.

Candidate and preflight builds use **Ubuntu 24.04**, not a moving native-build baseline. The packaged node-pty Node-API addon still needs exact-host loading/native acceptance; a module ABI number alone is neither proof of compatibility nor a failure diagnosis. ELF/hash inspection does not independently certify every glibc symbol or Electron combination.

## Authority And Visibility

[.github/release-maintainers.json](.github/release-maintainers.json) pins the destination repository and approved GitHub logins. Changing it is a security-sensitive reviewed PR, not contributor self-enrollment. Hosted authorization requires both that allowlist and current repository `admin`/`maintain` permission, the exact current `main` commit, and explicitly selected `private` or `public` visibility. Private is the default; a visibility mismatch fails rather than silently publishing somewhere else.

The workflow is manual-only. Candidate/preflight jobs have read-only permissions; only publication receives `contents: write`. Fork PRs and arbitrary dispatch actors cannot authorize release. The `linewise-release` environment must have reviewed deployment protection before public publication. Naming an environment in YAML alone does not create an enforced second reviewer; verify actual settings. Where private-plan protection is unavailable, retain the limitation rather than claiming enforcement.

Local acceptance records the authenticated GitHub maintainer login in the legacy `owner` field. It is a checksum/commit-bound operator attestation, **not a cryptographic proof** of who clicked controls or of a second-person review. Human smoke and independent review must actually happen.

## Gates

1. Review and commit the exact source, version/lock roots, curated changelog, license inventory, native/browser pins, and sanitized public docs. Keep commits; do not bundle private evidence or rewrite history as a cosmetic rename.
2. On that exact current-main commit, dispatch **Linewise Alpha Release**, phase `candidate`, with the intended visibility. Locked install, complete deterministic/public checks, moderate audit, package build, and strict archive verification must pass. The bounded artifact has VSIX, checksum, candidate metadata, and curated notes only; no tag/release is created.
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
  --manual-smoke-passed --rollback=unavailable-first-release
```

`release:accept` requires a clean matching commit, actual branded CLI versions, a fresh dependency audit, the complete release/native/crash gate, and an extracted exact-VSIX native check. It writes a new-only mode-0600 attestation outside the candidate directory. It does not bypass or automate owner desktop smoke.

For a later release use `--rollback=passed` only after testing an actual validated previous package. First-release rollback is unavailable; restoring an extension never restores workspace files, provider state, memory, or external effects.

## Launch Checklist

Source publicization and artifact release are separate decisions. Before changing visibility, verify [public readiness](docs/public-readiness.md), hosted logs/artifacts, contributor paths, private vulnerability reporting, branch/environment protections, licenses, and explicit owner visibility approval. No current source version or historical private test is itself that approval.
