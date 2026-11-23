# Attribution

Linewise is an independent project. Project-owned code is MIT licensed under the existing [LICENSE](LICENSE), including its copyright notice. Git history credits contributors; personal names or additional public acknowledgements are opt-in.

## Upstream Foundations

- [Oh My Pi](https://github.com/can1357/oh-my-pi) supplies the separately installed agent runtime, provider authentication, and agent orchestration. It is not redistributed in the VSIX.
- [Agent Client Protocol](https://agentclientprotocol.com/) and its [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) provide the editor/agent protocol.
- [VS Code](https://github.com/microsoft/vscode), [Monaco](https://github.com/microsoft/monaco-editor), and [Codicons](https://github.com/microsoft/vscode-codicons) supply public editor APIs, the readonly review editor, and native-style iconography. Bundled Codicons glyphs retain CC-BY-4.0 attribution.
- [Playwright](https://github.com/microsoft/playwright) and [node-pty](https://github.com/microsoft/node-pty) support explicitly owned browser and terminal workflows.

The complete bundled component inventory and license texts are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Preserve that file and the packaged upstream notices when distributing modified builds. Dependency versions and hashes are pinned or locked; upstream license ownership is not replaced by Linewise's MIT grant.

## Inspiration And Comparison

VS Code's Local chat workflow informs interaction density, disclosures, approvals, and granular review. Linewise uses public APIs and an extension-owned journal/custom editor, not Local's private working set or ordinary-editor widget. Microsoft and GitHub names and interfaces identify the products being compared; they do not imply affiliation or endorsement.

[PDFCraft](https://github.com/storytold/pdfcraft), part of the ArtCraft ecosystem, informed the approach to visual documentation, honest alpha limitations, linked technical docs, attribution, and concise verification-oriented PRs. No ArtCraft branding, assets, license claims, or contribution statistics are imported.

Public visual assets must identify their synthetic fixture, producing surface, versions, and any comparison limits. A recorded Local participant is not an authenticated agent run. Documentation screenshots and comparison evidence must not contain private projects, credentials, or account data. See [SECURITY.md](SECURITY.md).
