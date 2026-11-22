import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = 'node_modules/playwright-core';
const inventoryPath = 'quality/playwright-runtime.json';

export async function browserInventory() {
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.equal(inventory.version, '1.65.1');
  assert.ok(Object.keys(inventory.files).length > 0);
  for (const [name, digest] of Object.entries(inventory.files)) {
    assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..') && !name.includes('\\'));
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
  return inventory;
}

async function installedFiles(directory = root) {
  const files = [];
  const children = await readdir(directory);
  for (const name of children.sort()) {
    const target = path.join(directory, name);
    const metadata = await lstat(target);
    assert.ok(!metadata.isSymbolicLink(), 'Browser runtime symlinks are forbidden.');
    if (metadata.isDirectory()) {
      const nested = await installedFiles(target);
      files.push(...nested);
    } else {
      assert.ok(metadata.isFile() && metadata.size > 0 && metadata.size <= 16 * 1024 * 1024);
      files.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  return files;
}

export async function copyBrowserRuntime() {
  const inventory = await browserInventory();
  const names = await installedFiles();
  assert.deepEqual(names.sort(), Object.keys(inventory.files).sort());
  for (const name of names) {
    const bytes = await readFile(path.join(root, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), inventory.files[name], name);
  }
  await rm('dist/playwright', { recursive: true, force: true });
  await cp(root, 'dist/playwright', { recursive: true });
  console.log(`Verified pinned Playwright runtime: ${names.length} files.`);
}

async function record() {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '1.65.1');
  const files = {};
  const names = await installedFiles();
  for (const name of names) {
    const bytes = await readFile(path.join(root, name));
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  await mkdir('quality', { recursive: true });
  await writeFile(
    inventoryPath,
    `${JSON.stringify({ version: manifest.version, files }, null, 2)}\n`,
    { flag: 'wx' },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'record') await record();
  else await copyBrowserRuntime();
}
