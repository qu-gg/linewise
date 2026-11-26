import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTestDisplay } from './test-display.mjs';

await ensureTestDisplay();
const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-search-probe-'));
const reports = path.resolve('reports/search-index');
await mkdir(reports, { recursive: true, mode: 0o700 });
const report = await mkdtemp(path.join(reports, 'run-'));
const workspace = path.join(directory, 'workspace');
const extension = path.join(directory, 'extension');
const userData = path.join(directory, 'user-data');
try {
  for (const folder of [workspace, extension, path.join(userData, 'User')])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(extension, 'package.json'),
    JSON.stringify({
      name: 'omp-search-probe',
      publisher: 'vs-omp-fixture',
      version: '0.0.0',
      engines: { vscode: '^1.147.0' },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(userData, 'User/settings.json'),
    JSON.stringify({
      'chat.disableAIFeatures': true,
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none',
      'files.watcherExclude': { '**/scale-*': true },
    }),
    { mode: 0o600 },
  );
  await build({
    entryPoints: ['src/test/search.integration.ts'],
    outfile: path.join(extension, 'test.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
  });
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(extension, 'test.cjs'),
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      VS_OMP_SEARCH_REPORT: path.join(report, 'result.json'),
      VS_OMP_SEMANTIC_FIXTURE: path.resolve('src/test/semantic-relevance.json'),
    },
    launchArgs: [
      workspace,
      '--no-sandbox',
      '--disable-gpu',
      '--password-store=basic',
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--user-data-dir',
      userData,
      '--shared-data-dir',
      path.join(directory, 'shared-data'),
      '--extensions-dir',
      path.join(directory, 'extensions'),
    ],
  });
  console.log(
    `PASS: native lexical scale, semantic relevance and source freshness. Evidence: ${report}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
