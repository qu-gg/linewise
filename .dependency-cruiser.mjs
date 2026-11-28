export default {
  forbidden: [
    {
      name: 'transport-not-host',
      severity: 'error',
      from: { path: '^src/acp\\.ts$' },
      to: { path: '^(vscode$|src/(extension|workspace)\\.ts$)' },
    },
    {
      name: 'vscode-owned-by-host-adapters',
      severity: 'error',
      from: {
        path: '^(src/(?!test/)|media/)',
        pathNot:
          '^src/(extension|workspace|host-tools|host-permissions|host-inspect|host-search|host-questions|host-rename|host-code-actions|host-notebook|host-image-context|host-tasks|host-terminals|chat-view|inline-review-view|storage-view|host-view|host-activation|integrated-browser|pr-prepare)\\.ts$',
      },
      to: { path: '^vscode$' },
    },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-unresolved',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: '^vscode$' },
    },
    {
      name: 'production-not-tests-or-tooling',
      severity: 'error',
      from: { path: '^(src/(?!test/)|media/)' },
      to: { path: '^(src/test/|quality/|scripts/)' },
    },
    {
      name: 'production-not-dev-dependencies',
      severity: 'error',
      from: { path: '^(src/(?!test/)|media/)' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'webview-not-host',
      severity: 'error',
      from: { path: '^media/' },
      to: {
        path: '^(src/|node:|vscode$|@agentclientprotocol/)',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'webview-not-core',
      severity: 'error',
      from: { path: '^media/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'domain-not-host-or-transport',
      severity: 'error',
      from: {
        path: '^src/(review|review-types|review-hunks|path-guard|state|storage|storage-policy|retention|history|omp-guard)\\.ts$',
      },
      to: {
        path: '^(vscode$|src/(extension|workspace|acp|terminal|host-tools|host-permissions|host-inspect|host-questions|host-rename|host-code-actions|host-notebook|host-image-context|host-tasks|host-fetch|host-view|host-activation|chat-view|inline-review-view|storage-view|session-start|session-prompt)\\.ts$|@agentclientprotocol/)',
      },
    },
    {
      name: 'journal-has-no-concrete-adapters',
      severity: 'error',
      from: { path: '^src/review\\.ts$' },
      to: { path: '^src/', pathNot: '^src/(review-types|review-hunks|path-guard)\\.ts$' },
    },
    {
      name: 'history-cannot-resolve-reviews',
      severity: 'error',
      from: { path: '^src/history\\.ts$' },
      to: { path: '^src/review\\.ts$' },
    },
    {
      name: 'process-creation-is-confined',
      severity: 'error',
      from: {
        path: '^(src/|media/)',
        pathNot: '^src/(acp|extension|terminal|pr-evidence)\\.ts$|^src/test/',
      },
      to: { path: '^(node:)?child_process$' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
      extensions: ['.ts', '.js', '.mjs'],
      extensionAlias: { '.js': ['.ts', '.js'] },
    },
  },
};
