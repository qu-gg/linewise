import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yauzl from 'yauzl';
import { parseStringPromise } from 'xml2js';
import { ptyRuntimeFiles } from './pty-runtime.mjs';

export const profile = 'local-linux-x64-single-root';
const browserFiles = JSON.parse(
  readFileSync(new URL('../quality/playwright-runtime.json', import.meta.url), 'utf8'),
).files;
const required = [
  'extension/package.json',
  'extension/readme.md',
  'extension/LICENSE.txt',
  'extension/THIRD_PARTY_NOTICES.txt',
  'extension/dist/extension.cjs',
  'extension/dist/omp-guard.js',
  'extension/dist/review.js',
  'extension/dist/webview/main.js',
  'extension/dist/webview/main.css',
  'extension/dist/webview/inline-review.js',
  'extension/dist/webview/inline-review.css',
  'extension/dist/webview/inline-worker.js',
  'extension/dist/webview/monaco-LICENSE.txt',
  'extension/dist/webview/monaco-ThirdPartyNotices.txt',
  'extension/dist/webview/monaco-marked-LICENSE.txt',
  '[Content_Types].xml',
  'extension.vsixmanifest',
  ...Object.keys(browserFiles).map((name) => `extension/dist/playwright/${name}`),
  ...['runtime.json', ...ptyRuntimeFiles].map((name) => `extension/dist/pty/${name}`),
];

export function versionTag(manifest, lock) {
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(manifest.name, 'vs-omp');
  assert.equal(manifest.publisher, 'vs-omp-local');
  assert.equal(manifest.license, 'MIT');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  return `v${manifest.version}`;
}

export function validateEntries(entries) {
  const names = entries.map((entry) => entry.name);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
  for (const name of required) assert.ok(names.includes(name), `Missing package entry: ${name}`);
  assert.equal(
    names.filter((name) => /^extension\/dist\/webview\/codicon-[\w-]+\.ttf$/.test(name)).length,
    1,
  );
  for (const entry of entries) {
    assert.ok(
      required.includes(entry.name) ||
        /^extension\/dist\/webview\/codicon-[\w-]+\.ttf$/.test(entry.name),
      `Unexpected package entry: ${entry.name}`,
    );
    const mode = entry.externalFileAttributes >>> 16;
    assert.ok((mode & 0o170000) !== 0o120000, 'Package symlinks are forbidden');
    assert.ok(entry.size > 0 && entry.size <= 16 * 1024 * 1024, 'Invalid package entry size');
  }
  assert.ok(entries.reduce((total, entry) => total + entry.size, 0) <= 32 * 1024 * 1024);
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function archiveEntries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      const contents = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve({ entries, contents }));
      zip.on('entry', async (entry) => {
        try {
          entries.push({
            name: entry.fileName,
            size: entry.uncompressedSize,
            externalFileAttributes: entry.externalFileAttributes,
          });
          assert.ok(
            entries.length <= required.length + 1 && entry.uncompressedSize <= 16 * 1024 * 1024,
          );
          assert.ok(
            entries.reduce((total, current) => total + current.size, 0) <= 32 * 1024 * 1024,
          );
          contents.set(entry.fileName, await readEntry(zip, entry));
          zip.readEntry();
        } catch (failure) {
          zip.close();
          reject(failure);
        }
      });
      zip.readEntry();
    });
  });
}

async function inspectPtyRuntime(contents) {
  const prefix = 'extension/dist/pty/';
  const runtime = JSON.parse(contents.get(`${prefix}runtime.json`).toString('utf8'));
  assert.deepEqual(Object.keys(runtime).sort(), [
    'arch',
    'electron',
    'files',
    'node',
    'platform',
    'version',
  ]);
  assert.equal(runtime.version, '1.1.0');
  assert.equal(runtime.platform, 'linux');
  assert.equal(runtime.arch, 'x64');
  assert.deepEqual(Object.keys(runtime.files).sort(), [...ptyRuntimeFiles].sort());
  for (const name of ptyRuntimeFiles) {
    const bytes = contents.get(`${prefix}${name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), runtime.files[name]);
    if (name !== 'build/Release/pty.node')
      assert.deepEqual(bytes, await readFile(`dist/pty/${name}`));
  }
  const native = contents.get(`${prefix}build/Release/pty.node`);
  assert.deepEqual([...native.subarray(0, 6)], [127, 69, 76, 70, 2, 1]);
  assert.equal(native.readUInt16LE(18), 62);
}

export async function inspectPackage(file, manifest) {
  const bytes = await readFile(file);
  assert.ok(bytes.length <= 32 * 1024 * 1024);
  const { entries, contents } = await archiveEntries(file);
  validateEntries(entries);
  await inspectPtyRuntime(contents);
  for (const [name, digest] of Object.entries(browserFiles)) {
    assert.equal(
      createHash('sha256')
        .update(contents.get(`extension/dist/playwright/${name}`))
        .digest('hex'),
      digest,
      `Changed browser runtime: ${name}`,
    );
  }
  const packaged = JSON.parse(contents.get('extension/package.json').toString('utf8'));
  for (const key of ['name', 'publisher', 'version', 'license'])
    assert.equal(packaged[key], manifest[key]);
  const xml = await parseStringPromise(contents.get('extension.vsixmanifest').toString('utf8'));
  const identity = xml.PackageManifest.Metadata[0].Identity[0].$;
  assert.equal(identity.Id, manifest.name);
  assert.equal(identity.Publisher, manifest.publisher);
  assert.equal(identity.Version, manifest.version);
  assert.equal(identity.TargetPlatform, 'linux-x64');
  for (const [packagedName, sourceName] of [
    ['LICENSE.txt', 'LICENSE'],
    ['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'],
    ['dist/webview/monaco-LICENSE.txt', 'node_modules/monaco-editor/LICENSE'],
    [
      'dist/webview/monaco-ThirdPartyNotices.txt',
      'node_modules/monaco-editor/ThirdPartyNotices.txt',
    ],
    [
      'dist/webview/monaco-marked-LICENSE.txt',
      'node_modules/monaco-editor/node_modules/marked/LICENSE.md',
    ],
  ]) {
    const source = await readFile(sourceName);
    assert.ok(
      contents.get(`extension/${packagedName}`).equals(source),
      `Changed upstream notice: ${packagedName}`,
    );
  }
  return {
    file: path.basename(file),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

export function validateCandidate(candidate, manifest, commit) {
  assert.equal(candidate.schema, 1);
  assert.equal(candidate.commit, commit);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(candidate.version, manifest.version);
  assert.equal(candidate.tag, `v${manifest.version}`);
  assert.equal(candidate.profile, profile);
  assert.equal(candidate.target, 'linux-x64');
  assert.equal(candidate.package.file, `vs-omp-${manifest.version}-linux-x64.vsix`);
  assert.match(candidate.package.sha256, /^[a-f0-9]{64}$/);
}

export function validateAcceptance(acceptance, candidate) {
  const keys = [
    'schema',
    'commit',
    'sha256',
    'profile',
    'platform',
    'arch',
    'omp',
    'vscode',
    'owner',
    'native',
    'packaged',
    'manualSmoke',
    'scopeExclusionsAcknowledged',
    'rollback',
  ];
  assert.deepEqual(Object.keys(acceptance).sort(), keys.sort(), 'Unexpected acceptance fields');
  assert.equal(acceptance.schema, 1);
  assert.equal(acceptance.commit, candidate.commit);
  assert.equal(acceptance.sha256, candidate.package.sha256);
  assert.equal(acceptance.profile, profile);
  assert.equal(acceptance.platform, 'linux');
  assert.equal(acceptance.arch, 'x64');
  assert.equal(acceptance.omp, '18.21.0');
  assert.equal(acceptance.vscode, '1.146.0');
  assert.equal(acceptance.owner, 'qu-gg');
  assert.equal(acceptance.native, true);
  assert.equal(acceptance.packaged, true);
  assert.equal(acceptance.manualSmoke, true);
  assert.equal(acceptance.scopeExclusionsAcknowledged, true);
  assert.ok(['passed', 'unavailable-first-release'].includes(acceptance.rollback));
}

export function releaseNotes(changelog, version) {
  const marker = `## ${version}\n`;
  assert.ok(changelog.includes(marker), 'Missing versioned changelog entry');
  const notes = changelog.split(marker)[1].split('\n## ')[0].trim();
  assert.ok(notes.length >= 100 && notes.length <= 16000, 'Invalid release notes length');
  return notes;
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function verifyDirectory(directory, commit, evidence) {
  const manifest = await json('package.json');
  const candidate = await json(path.join(directory, 'release-candidate.json'));
  versionTag(manifest, await json('package-lock.json'));
  validateCandidate(candidate, manifest, commit);
  const allowed = [
    candidate.package.file,
    'SHA256SUMS',
    'release-candidate.json',
    'release-notes.md',
  ];
  assert.deepEqual((await readdir(directory)).sort(), allowed.sort(), 'Unexpected candidate files');
  const inspected = await inspectPackage(path.join(directory, candidate.package.file), manifest);
  assert.deepEqual(inspected, candidate.package);
  const checksum = `${inspected.sha256}  ${inspected.file}\n`;
  assert.equal(await readFile(path.join(directory, 'SHA256SUMS'), 'utf8'), checksum);
  const notes = releaseNotes(await readFile('CHANGELOG.md', 'utf8'), manifest.version);
  assert.equal(await readFile(path.join(directory, 'release-notes.md'), 'utf8'), `${notes}\n`);
  if (evidence) validateAcceptance(await json(evidence), candidate);
  return candidate;
}

async function candidateCommand(directory, commit) {
  const manifest = await json('package.json');
  const tag = versionTag(manifest, await json('package-lock.json'));
  const packageInfo = await inspectPackage(
    path.join(directory, `vs-omp-${manifest.version}-linux-x64.vsix`),
    manifest,
  );
  const candidate = {
    schema: 1,
    commit,
    version: manifest.version,
    tag,
    profile,
    target: 'linux-x64',
    package: packageInfo,
  };
  validateCandidate(candidate, manifest, commit);
  await writeFile(
    path.join(directory, 'release-candidate.json'),
    `${JSON.stringify(candidate, null, 2)}\n`,
    { flag: 'wx' },
  );
  await writeFile(
    path.join(directory, 'SHA256SUMS'),
    `${packageInfo.sha256}  ${packageInfo.file}\n`,
    { flag: 'wx' },
  );
  const notes = releaseNotes(await readFile('CHANGELOG.md', 'utf8'), manifest.version);
  await writeFile(path.join(directory, 'release-notes.md'), `${notes}\n`, { flag: 'wx' });
}

async function main() {
  const [command, directory, commit, evidence] = process.argv.slice(2);
  assert.ok(
    directory && commit,
    'Usage: release.mjs candidate|verify|publish-ready DIRECTORY COMMIT [EVIDENCE]',
  );
  if (command === 'candidate') await candidateCommand(directory, commit);
  else if (command === 'verify') await verifyDirectory(directory, commit);
  else if (command === 'publish-ready') {
    assert.ok(evidence, 'Local acceptance evidence is required');
    await verifyDirectory(directory, commit, evidence);
  } else throw new Error('Unknown release command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
