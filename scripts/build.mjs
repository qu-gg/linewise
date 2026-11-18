import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

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
  entryPoints: ['media/main.js', 'media/main.css'],
  outdir: 'dist/webview',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  loader: { '.ttf': 'file' },
  sourcemap: true,
});
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
  entryPoints: ['src/test/crash.integration.ts'],
  outfile: 'dist/test/crash-host/driver.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
});
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
