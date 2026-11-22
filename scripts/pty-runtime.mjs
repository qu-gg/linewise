import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = 'node_modules/node-pty';
const inventoryPath = 'quality/node-pty-runtime.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const ptyRuntimeFiles = [
  'index.cjs',
  'build/Release/pty.node',
  'LICENSE',
  'NODE_ADDON_API_LICENSE.md',
];

export function rebuildPtyRuntime() {
  assert.equal(process.platform, 'linux');
  assert.ok(process.versions.electron, 'Rebuild using VS Code with ELECTRON_RUN_AS_NODE=1.');
  execFileSync(
    process.execPath,
    [
      'node_modules/node-gyp/bin/node-gyp.js',
      'rebuild',
      '--directory=node_modules/node-pty',
      `--target=${process.versions.electron}`,
      '--dist-url=https://electronjs.org/headers',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, PYTHON: '/usr/bin/python3', npm_config_python: '/usr/bin/python3' },
    },
  );
}

async function sourceFiles(directory = `${root}/lib`) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'PTY runtime symlinks are forbidden.');
    if (entry.isDirectory()) {
      const nested = await sourceFiles(target);
      files.push(...nested);
    } else if (entry.name.endsWith('.js')) files.push(target);
  }
  return files;
}

async function sourceInventory() {
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  assert.equal(manifest.version, '1.1.0');
  const files = {};
  const sources = await sourceFiles();
  for (const name of [
    ...sources,
    `${root}/LICENSE`,
    `${root}/package.json`,
    'node_modules/node-addon-api/LICENSE.md',
  ].sort())
    files[name] = digest(await readFile(name));
  return { version: manifest.version, files };
}

export async function copyPtyRuntime() {
  assert.equal(process.platform, 'linux', 'The PTY runtime is validated for Linux only.');
  const expected = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.deepEqual(await sourceInventory(), expected, 'Pinned PTY runtime sources changed.');
  const native = `${root}/build/Release/pty.node`;
  const links = execFileSync('readelf', ['-d', native], { encoding: 'utf8' });
  assert.doesNotMatch(
    links,
    /Shared library: \[lib(?:node|uv)\b/,
    'PTY must not link a foreign Node runtime.',
  );
  await rm('dist/pty', { recursive: true, force: true });
  await mkdir('dist/pty/build/Release', { recursive: true });
  await build({
    entryPoints: [`${root}/lib/index.js`],
    outfile: 'dist/pty/index.cjs',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
  });
  await cp(native, 'dist/pty/build/Release/pty.node');
  await cp(`${root}/LICENSE`, 'dist/pty/LICENSE');
  await cp('node_modules/node-addon-api/LICENSE.md', 'dist/pty/NODE_ADDON_API_LICENSE.md');
  const files = {};
  for (const name of ptyRuntimeFiles)
    files[name] = digest(await readFile(path.join('dist/pty', name)));
  await writeFile(
    'dist/pty/runtime.json',
    `${JSON.stringify(
      {
        version: '1.1.0',
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? null,
        node: process.version,
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log('Verified pinned PTY runtime sources and native linkage.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'record')
    await writeFile(inventoryPath, `${JSON.stringify(await sourceInventory(), null, 2)}\n`, {
      flag: 'wx',
    });
  else {
    if (process.argv[2] === 'rebuild') rebuildPtyRuntime();
    await copyPtyRuntime();
  }
}
