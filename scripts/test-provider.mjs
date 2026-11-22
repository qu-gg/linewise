import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { ensureTestDisplay } from './test-display.mjs';

function stableTesting(source) {
  const file = ts.createSourceFile('vscode.d.ts', source, ts.ScriptTarget.Latest, true);
  let names = [];
  const visit = (node) => {
    if (
      ts.isModuleDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'tests' &&
      node.body &&
      ts.isModuleBlock(node.body)
    )
      names = node.body.statements
        .filter(ts.isFunctionDeclaration)
        .map((entry) => entry.name.text)
        .sort();
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

await ensureTestDisplay();
const providerSource = process.argv[2];
if (providerSource && !path.isAbsolute(providerSource))
  throw new Error('The provider probe requires an explicit absolute installed-package path.');
const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-test-provider-'));
const reports = path.resolve('reports/test-provider');
await mkdir(reports, { recursive: true, mode: 0o700 });
const report = await mkdtemp(path.join(reports, 'run-'));
await chmod(report, 0o700);
const workspace = path.join(directory, 'workspace');
const extension = path.join(directory, 'extension');
const userData = path.join(directory, 'user-data');
const home = path.join(directory, 'home');
let passed = false;
try {
  for (const folder of [workspace, extension, home, path.join(userData, 'User')])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(extension, 'package.json'),
    JSON.stringify({
      name: 'omp-test-provider-probe',
      publisher: 'vs-omp-fixture',
      version: '0.0.0',
      engines: { vscode: '^1.146.0' },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(userData, 'User/settings.json'),
    JSON.stringify({
      'chat.disableAIFeatures': true,
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'extensions.ignoreRecommendations': true,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none',
      'python.languageServer': 'None',
      'python.useEnvironmentsExtension': false,
      'python.experiments.enabled': false,
      'python.testing.pytestEnabled': false,
      'python.testing.unittestEnabled': false,
      'python.testing.autoTestDiscoverOnSaveEnabled': false,
    }),
    { mode: 0o600 },
  );
  const development = [extension];
  if (providerSource) {
    const metadata = JSON.parse(await readFile(path.join(providerSource, 'package.json'), 'utf8'));
    if (
      `${metadata.publisher}.${metadata.name}` !== 'ms-python.python' ||
      metadata.version !== '2026.10.0'
    )
      throw new Error('The real-provider probe is pinned to ms-python.python 2026.10.0.');
    const copy = path.join(directory, 'provider');
    await cp(providerSource, copy, { recursive: true });
    development.push(copy);
  }
  await build({
    entryPoints: ['src/test/test-provider.integration.ts'],
    outfile: path.join(extension, 'test.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const safe = new Set([
    'DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'LANG',
    'LC_ALL',
  ]);
  const cleared = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => !safe.has(key))
      .map((key) => [key, undefined]),
  );
  await runTests({
    vscodeExecutablePath: '/usr/share/code/code',
    extensionDevelopmentPath: development,
    extensionTestsPath: path.join(extension, 'test.cjs'),
    extensionTestsEnv: {
      ...cleared,
      HOME: home,
      PATH: '/usr/bin:/bin',
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      VS_OMP_TEST_PROVIDER_PRESENT: providerSource ? '1' : '0',
      VS_OMP_TEST_PROVIDER_REPORT: path.join(report, 'result.json'),
      VS_OMP_STABLE_TEST_API: JSON.stringify(
        stableTesting(await readFile('node_modules/@types/vscode/index.d.ts', 'utf8')),
      ),
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
  const receipt = JSON.parse(await readFile(path.join(report, 'result.json'), 'utf8'));
  if (receipt.passed !== true)
    throw new Error('Missing passing test-provider feasibility receipt.');
  console.log(
    `PASS: test-provider feasibility ${receipt.outcome}; evidence ${path.relative(process.cwd(), report)}.`,
  );
  passed = true;
} finally {
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Retained failed provider-probe profile: ${directory}`);
}
