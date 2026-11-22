import { build as bundle } from 'esbuild';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyBrowserRuntime } from './browser-runtime.mjs';
import { copyPtyRuntime } from './pty-runtime.mjs';

await copyBrowserRuntime();
await copyPtyRuntime();
const browserRuntime = {
  name: 'pinned-browser-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^node-pty$/ }, () => ({
      path:
        './' +
        path
          .relative(path.dirname(builder.initialOptions.outfile), 'dist/pty/index.cjs')
          .split(path.sep)
          .join('/'),
      external: true,
    }));
    builder.onResolve({ filter: /^playwright-core$/ }, () => ({
      path:
        './' +
        path
          .relative(path.dirname(builder.initialOptions.outfile), 'dist/playwright/index.js')
          .split(path.sep)
          .join('/'),
      external: true,
    }));
  },
};
function build(options) {
  return bundle({
    ...options,
    alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
    plugins: [browserRuntime],
  });
}

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
});
await build({
  entryPoints: ['src/omp-guard.ts'],
  outfile: 'dist/omp-guard.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  external: ['@oh-my-pi/pi-natives'],
});
await build({
  entryPoints: [
    'media/main.js',
    'media/main.css',
    'media/inline-review.js',
    'media/inline-worker.js',
  ],
  outdir: 'dist/webview',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  loader: { '.ttf': 'file' },
  sourcemap: true,
});
for (const [source, destination] of [
  ['node_modules/monaco-editor/LICENSE', 'dist/webview/monaco-LICENSE.txt'],
  ['node_modules/monaco-editor/ThirdPartyNotices.txt', 'dist/webview/monaco-ThirdPartyNotices.txt'],
  [
    'node_modules/monaco-editor/node_modules/marked/LICENSE.md',
    'dist/webview/monaco-marked-LICENSE.txt',
  ],
])
  await copyFile(source, destination);
await build({
  entryPoints: ['src/test/extension.integration.ts'],
  outfile: 'dist/test/extension.integration.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
});
await build({
  entryPoints: ['src/test/live.integration.ts'],
  outfile: 'dist/test/live.integration.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
});
await build({
  entryPoints: ['src/test/terminal.integration.ts'],
  outfile: 'dist/test/native-ui/driver.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
});
await writeFile(
  'dist/test/native-ui/package.json',
  JSON.stringify({
    name: 'vs-omp-native-ui-test',
    publisher: 'vs-omp-fixture',
    version: '0.0.0',
    engines: { vscode: '^1.146.0' },
    activationEvents: ['onStartupFinished'],
    main: './driver.cjs',
    contributes: {
      viewsContainers: {
        secondarySidebar: [{ id: 'native-approvals', title: 'Approvals', icon: '$(shield)' }],
      },
      views: {
        'native-approvals': [
          { type: 'webview', id: 'native-approvals.chat', name: 'Native Approvals' },
        ],
      },
      configuration: JSON.parse(await readFile('package.json', 'utf8')).contributes.configuration,
    },
  }),
);

await build({
  entryPoints: ['src/test/chat-reference.integration.ts'],
  outfile: 'dist/test/chat-reference/driver.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
});
await writeFile(
  'dist/test/chat-reference/package.json',
  JSON.stringify({
    name: 'vs-omp-chat-reference',
    publisher: 'vs-omp-fixture',
    version: '0.0.0',
    engines: { vscode: '^1.146.0' },
    activationEvents: ['onStartupFinished'],
    main: './driver.cjs',
    contributes: {
      chatParticipants: [
        {
          id: 'vs-omp.reference',
          name: 'parity',
          fullName: 'Recorded Parity Reference',
          description: 'Read-only recorded fixture, no inference or commands.',
        },
      ],
      languageModelChatProviders: [
        { vendor: 'vs-omp-reference', displayName: 'Recorded Fixture Only' },
      ],
      languageModelTools: [
        {
          name: 'vs_omp_recorded_result',
          displayName: 'Recorded fixture result',
          modelDescription: 'Return a recorded read-only test result.',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' }, text: { type: 'string' } },
            required: ['title', 'text'],
          },
        },
      ],
    },
  }),
);

await build({
  entryPoints: ['src/test/crash.integration.ts'],
  outfile: 'dist/test/crash-host/driver.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
});
await build({
  entryPoints: ['src/test/terminal-lifecycle.integration.ts'],
  outfile: 'dist/test/terminal-lifecycle/driver.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
});
const terminalLifecycleManifest = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  'dist/test/terminal-lifecycle/package.json',
  JSON.stringify({
    name: 'vs-omp-terminal-lifecycle',
    publisher: 'vs-omp-fixture',
    version: '0.0.0',
    engines: terminalLifecycleManifest.engines,
    capabilities: terminalLifecycleManifest.capabilities,
    activationEvents: ['onStartupFinished'],
    main: './driver.cjs',
    contributes: terminalLifecycleManifest.contributes,
  }),
);
await writeFile(
  'dist/test/crash-host/package.json',
  JSON.stringify({
    name: 'vs-omp-crash-test',
    publisher: 'vs-omp-fixture',
    version: '0.0.0',
    engines: { vscode: '^1.146.0' },
    activationEvents: ['onStartupFinished'],
    main: './driver.cjs',
    contributes: {
      viewsContainers: { secondarySidebar: [{ id: 'omp', title: 'OMP', icon: '$(history)' }] },
      views: { omp: [{ type: 'webview', id: 'omp.chat', name: 'OMP' }] },
      configuration: JSON.parse(await readFile('package.json', 'utf8')).contributes.configuration,
    },
  }),
);
