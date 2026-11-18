import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runNativeDialogs } from './native-dialogs.mjs';

async function isolatedExtension(directory) {
  if (process.env.VS_OMP_VSIX) {
    const extracted = path.join(directory, 'package');
    execFileSync('unzip', ['-q', path.resolve(process.env.VS_OMP_VSIX), '-d', extracted]);
    return path.join(extracted, 'extension');
  }
  const isolated = path.join(directory, 'isolated-extension');
  for (const relative of [
    'package.json',
    'dist/extension.cjs',
    'dist/omp-guard.js',
    'dist/review.js',
    'dist/webview',
  ]) {
    const destination = path.join(isolated, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(process.cwd(), relative), destination, { recursive: true });
  }
  return isolated;
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-extension-'));
const workspace = path.join(directory, 'workspace');
const userData = path.join(directory, 'user-data');
await mkdir(workspace);
await writeFile(
  path.join(workspace, 'AGENTS.md'),
  'VS_OMP_INSTRUCTION_DISCOVERY_SENTINEL: preserve existing user work.\n',
);
await mkdir(userData);
try {
  const extensionDevelopmentPath = await isolatedExtension(directory);
  await runNativeDialogs(directory);
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    extensionDevelopmentPath,
    extensionTestsPath: path.join(process.cwd(), 'dist/test/extension.integration.cjs'),
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      VS_OMP_TEST_FIXTURE: path.join(process.cwd(), 'scripts/history-fixture.mjs'),
      VS_OMP_FIXTURE_NATIVE: '1',
      VS_OMP_FIXTURE_CONTEXT: path.join(directory, 'provider-context.json'),
    },
    launchArgs: [
      workspace,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--user-data-dir',
      userData,
      '--extensions-dir',
      path.join(directory, 'extensions'),
    ],
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
