# Security And Privacy

Linewise is an early alpha coding-agent extension, not an OS sandbox. Use disposable workspaces first and back up important work. No public release is currently security-certified; a clean scanner or dependency audit is not proof of vulnerability-free code.

## Report Privately

Before public launch, maintainers must enable GitHub private vulnerability reporting. When enabled, use **Security -> Report a vulnerability** on this repository. Include the affected version/commit, a minimal synthetic reproduction, expected and observed behavior, and the suspected impact. Do not attach real credentials or private source.

If private reporting is unavailable, open an issue asking only for a confidential contact channel, without the vulnerability, exploit, logs, or sensitive details. Maintainers must arrange that channel before requesting the report. Do not use ordinary Issues or Discussions to disclose an unpatched vulnerability.

Maintainers will triage reports and coordinate a fix and disclosure. This small early-stage project does not promise a response SLA, bounty, or support for every historical build. Supported security fixes target the current alpha development line and any explicitly supported release listed in [RELEASE.md](RELEASE.md).

## Trust Boundaries

- **File tools:** canonical-path/private-storage checks, outside-workspace consent, exact captured preimages, and a durable review journal mediate supported operations. Provider commands and unsupported mutation routes remain disabled.
- **Commands and tasks:** run with the user's host permissions. They can read files, invoke programs, use credentials, access the network, and change external state. A minimal inherited environment is not containment. Process-group cleanup cannot contain deliberately detached groups or undo side effects.
- **Permissions:** Command Rules and Ask are persisted defaults. Allow All and YOLO require explicit confirmation and inherit across new chats in the same workbench window. Elevated modes reset on extension reload, workspace trust change, or history rollback; reconnect preserves the current mode. User deny/ask rules remain, but static command matching cannot understand arbitrary scripts, variables, interpreters, or obfuscation. YOLO is not a security boundary.
- **Web access:** each URL/redirect requires independent consent for `fetch`. Consent may authorize an internal/local host; this is not SSRF isolation. GET can have server-side effects. Owned browser pages can make background requests and retain site state across prompts until revoked.
- **Untrusted content:** file, notebook, tool, and web output can contain prompt injection. Validation and consent limit authority; they do not make model output trustworthy. Inspect proposed actions rather than treating instructions embedded in content as authorization.
- **Webviews:** strict message schemas and CSP separate presentation from host decisions. No arbitrary browser JavaScript or private workbench integration is exposed as a model tool.

Keep/Undo applies only to journaled file-tool operations. It does not undo shell/task/web effects, restore Git, erase provider history, or make conversation forks machine-state checkpoints.

## Data Flow And Storage

OMP sends prompts, selected context, approved reads, tool results, and relevant history to the selected model provider. Current integration uses OMP's GitHub Copilot provider and OMP-managed authentication. Linewise does not extract VS Code's Copilot tokens or copy authentication into test profiles. Provider billing, retention, account entitlements, and organization policies remain the provider's responsibility.

There is no extension telemetry. This does not mean offline operation: provider calls, approved browsing/fetch, commands, and configured upstream behavior can use the network. Compaction may consume model requests.

Transcripts, archives, submitted text/images, and before/after review snapshots reside in extension storage on the workspace host. State files use mode 0600 and directories 0700 on the supported Linux profile. These modes are not encryption or protection from other software running as the same user. Images may contain sensitive pixels or metadata. OMP's separate local memory may retain facts from abandoned conversation branches.

**Linewise: Inspect Storage** is read-only. Export creates a private new-only file containing sensitive session data; it is not a resumable backup. Delete/retention/orphan cleanup requires confirmation and protects active/review/recovery owners. Deletion is not secure erasure and does not remove exports, backups, provider copies, shell effects, or separate OMP memory.

Human terminal takeover permanently withholds that execution's future model-visible capture. It does not erase previous output or scrollback. Type secrets directly into the owned terminal, never chat, tool arguments, screenshots, or reports. Resume Agent and actual process completion jointly release hand-back.

## Public-Release Checks

Review source and reachable history, pending/untracked files, dependency advisories, bundled licenses/native runtimes, hosted logs/artifacts, and visual assets before publication. Rotate/revoke any discovered credential before removing it; rewriting history alone does not revoke it.

Only synthetic sanitized fixtures may enter public screenshots and reports. Do not publish user profiles, `.local-dev/`, `reports/`, session JSONL, raw crash traces, or provider logs. Public Actions logs are visible to everyone after a visibility change. The [quality policy](QUALITY.md) and [release gates](RELEASE.md) retain exact-artifact validation; wider platform/provider support needs separate evidence.
