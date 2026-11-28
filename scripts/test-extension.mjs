import { runTests } from '@vscode/test-electron';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runNativeDialogs,
  driveLiveQuestions,
  driveLiveTerminals,
  driveTerminalControls,
} from './native-dialogs.mjs';
import { liveSettings } from './live-guard.mjs';
import { ensureTestDisplay } from './test-display.mjs';
import { driveDocsCapture, driveNativeUX } from './native-ux.mjs';

const live = process.env.VS_OMP_LIVE_TESTS === '1';
const docsCapture = process.env.VS_OMP_CAPTURE_DOCS === '1';
if (live) liveSettings();
await ensureTestDisplay();
const questions =
  live && ['questions', 'mixed-questions', 'mixed-session'].includes(process.env.VS_OMP_LIVE_CASE);
const terminals = live && process.env.VS_OMP_LIVE_CASE === 'terminal-handoff';
const nativeInput = questions || terminals;

const installed = process.env.VS_OMP_INSTALLED_PROFILE
  ? await realpath(process.env.VS_OMP_INSTALLED_PROFILE)
  : undefined;
if (installed) {
  assert.equal(live, false, 'Installed-profile tests are scripted-only; no live inference');
  assert.ok(installed.startsWith(`${path.resolve('.local-dev/release')}/r01-authorization-`));
  assert.ok(['fresh-install', 'update-rollback'].includes(path.basename(installed)));
}

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
    'dist/playwright',
    'dist/pty',
    'dist/webview',
  ]) {
    const destination = path.join(isolated, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(process.cwd(), relative), destination, { recursive: true });
  }
  return isolated;
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-extension-'));
const profile = installed || directory;
const workspace = path.join(profile, 'workspace');
const workspaceFile = path.join(
  profile,
  installed ? 'test.code-workspace' : 'native.code-workspace',
);
const userData = path.join(profile, 'user-data');
const docsReady = path.join(directory, 'docs-ready');
const docsDone = path.join(directory, 'docs-done');
const settingsFile = path.join(userData, 'User', 'settings.json');
const originalSettings = installed ? await readFile(settingsFile) : undefined;
const installedFolders = installed
  ? (await readdir(path.join(profile, 'extensions'))).filter((name) =>
      name.startsWith('vs-omp-local.vs-omp-'),
    )
  : [];
if (installed) assert.equal(installedFolders.length, 1, 'Require one installed OMP package');
const installedExtension = installed
  ? await realpath(path.join(profile, 'extensions', installedFolders[0]))
  : undefined;
if (installed) {
  await rm(path.join(userData, 'DevToolsActivePort'), { force: true });
  const markers = await readdir(workspace);
  for (const name of markers) {
    if (/^native-onboarding-(missing|incompatible|auth|connected)(\.json|-checked)$/.test(name))
      await rm(path.join(workspace, name));
  }
}
let liveReport;
if (live) {
  await chmod(path.resolve('scripts/live-omp.mjs'), 0o755);
  const reports = path.resolve('reports', 'live');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(path.join(reports, 'run-'));
  liveReport = path.join(run, 'observer.json');
  console.log(`Live test report: ${liveReport}`);
}
await mkdir(workspace, { recursive: true });
if (!live && !installed)
  await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }] }));
await writeFile(
  path.join(workspace, 'AGENTS.md'),
  'VS_OMP_INSTRUCTION_DISCOVERY_SENTINEL: preserve existing user work.\n',
);
await mkdir(userData, { recursive: true });
await mkdir(path.join(userData, 'User'), { recursive: true });
await writeFile(
  settingsFile,
  JSON.stringify({
    ...(originalSettings ? JSON.parse(originalSettings.toString('utf8')) : {}),
    'task.saveBeforeRun': 'never',
    ...(process.env.OMP_EXECUTABLE ? { 'omp.executablePath': process.env.OMP_EXECUTABLE } : {}),
    ...(installed
      ? { 'omp.permissions.defaultMode': 'rules', 'omp.permissions.useDefaultRules': true }
      : {}),
  }),
  { mode: 0o600 },
);
let passed = false;
try {
  const extensionDevelopmentPath = installed ? undefined : await isolatedExtension(directory);
  const resourcesFixture = path.join(directory, 'resource-fixture');
  await mkdir(resourcesFixture);
  await writeFile(
    path.join(resourcesFixture, 'package.json'),
    JSON.stringify({
      name: 'omp-native-resource-fixture',
      publisher: 'vs-omp-fixture',
      version: '0.0.0',
      engines: { vscode: '^1.147.0' },
      contributes: {
        notebooks: [
          {
            type: 'omp-parity-fixture',
            displayName: 'Parity Notebook Fixture',
            selector: [{ filenamePattern: '*.ompnotebook' }, { filenamePattern: '*.ipynb' }],
          },
        ],
      },
    }),
  );
  if (!live && !installed && !docsCapture) await runNativeDialogs(directory);
  const testOptions = {
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || '/usr/share/code/code',
    extensionDevelopmentPath: extensionDevelopmentPath
      ? [extensionDevelopmentPath, resourcesFixture]
      : [resourcesFixture],
    extensionTestsPath: path.join(
      process.cwd(),
      `dist/test/${live ? 'live' : 'extension'}.integration.cjs`,
    ),
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      VS_OMP_TEST_FIXTURE: path.join(
        process.cwd(),
        live ? 'scripts/live-guard.mjs' : 'scripts/history-fixture.mjs',
      ),
      VS_OMP_FIXTURE_NATIVE: '1',
      ...(process.env.OMP_EXECUTABLE ? { OMP_EXECUTABLE: process.env.OMP_EXECUTABLE } : {}),
      VS_OMP_EXPECTED_EXTENSION_PATH: installedExtension,
      VS_OMP_UX_REOPEN: undefined,
      VS_OMP_DOCS_CAPTURE: docsCapture ? '1' : undefined,
      VS_OMP_DOCS_READY: docsReady,
      VS_OMP_DOCS_DONE: docsDone,
      VS_OMP_FIXTURE_CONTEXT: path.join(directory, 'provider-context.json'),
      ...(live
        ? {
            VS_OMP_LIVE_REPORT: liveReport,
            VS_OMP_LIVE_USER_DATA: userData,
            VS_OMP_LIVE_SOURCE_ROOT: process.cwd(),
            VS_OMP_LIVE_EXECUTABLE: path.resolve('scripts/live-omp.mjs'),
          }
        : {}),
    },
    launchArgs: [
      live ? workspace : workspaceFile,
      '--no-sandbox',
      '--disable-gpu',
      '--password-store=basic',
      ...(!installed ? ['--disable-extensions'] : []),
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      ...(nativeInput || !live
        ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']
        : []),
      '--user-data-dir',
      userData,
      '--shared-data-dir',
      path.join(profile, 'shared-data'),
      '--extensions-dir',
      path.join(profile, 'extensions'),
    ],
  };
  const testing = runTests(testOptions);
  const outcomes = await Promise.allSettled([
    testing,
    ...(!live
      ? [
          docsCapture
            ? driveDocsCapture(userData, workspace, docsReady, docsDone)
            : driveNativeUX(userData, workspace, !!installed),
          ...(!installed && !docsCapture ? [driveTerminalControls(userData, workspace)] : []),
        ]
      : []),
    ...(nativeInput
      ? [
          (terminals ? driveLiveTerminals : driveLiveQuestions)(
            userData,
            workspace,
            liveReport,
            liveSettings().seconds * 1000,
          ),
        ]
      : []),
  ]);
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((outcome) => outcome.reason));
  if (!live && !installed && !docsCapture)
    await runTests({
      ...testOptions,
      extensionTestsEnv: { ...testOptions.extensionTestsEnv, VS_OMP_UX_REOPEN: '1' },
    });
  passed = true;
} catch (error) {
  if (liveReport)
    await writeFile(
      `${liveReport}.failure.json`,
      JSON.stringify({ passed: false, error: String(error) }),
      { mode: 0o600 },
    );
  throw error;
} finally {
  if (originalSettings) await writeFile(settingsFile, originalSettings, { mode: 0o600 });
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Retained failed extension-fixture evidence: ${directory}`);
}
