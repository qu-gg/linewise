## User Impact

What did the user see? What will change? Link the issue and stable TODO.md task ID when applicable; state whether this fully or partly addresses that atomic task.

## Cause And Change

Describe the root cause and smallest useful fix. Identify any permission, storage, runtime, provider, license, or compatibility impact.

## Verification

- Focused regression/check:
- Complete deterministic gate:
- Native/UI acceptance, versions and sanitized captures (when relevant):
- Unverified scope and why:

Scripted providers, browser fixtures, real-model runs, and exact-VSIX acceptance are different evidence. Report only checks actually run. Do not attach secrets, private source, profiles, raw session logs, or model thoughts.

## Review Checklist

- [ ] I understand and reviewed the change, including AI-assisted code.
- [ ] Tests and docs match the behavior; I did not lower quality gates.
- [ ] No private data or unrelated cleanup is included; third-party provenance/notices are preserved.
- [ ] Any new authority, supported scope, paid inference, or release requirement was discussed with maintainers.
