import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ESLint } from 'eslint';
import yazl from 'yazl';
import {
  profile,
  versionTag,
  validateEntries,
  validateCandidate,
  validateAcceptance,
  releaseNotes,
  inspectPackage,
  verifyDirectory,
} from '../scripts/release.mjs';
import { acceptanceArguments, validateRuntimeVersions } from '../scripts/release-accept.mjs';
import { validateRun } from '../scripts/release-run.mjs';
import { parse } from 'yaml';
import { copyPtyRuntime, ptyRuntimeFiles } from '../scripts/pty-runtime.mjs';

const manifest = { name: 'vs-omp', publisher: 'vs-omp-local', version: '0.0.2', license: 'MIT' };
const commit = 'a'.repeat(40);
const candidate = {
  schema: 1,
  commit,
  version: '0.0.2',
  tag: 'v0.0.2',
  profile,
  target: 'linux-x64',
  package: { file: 'vs-omp-0.0.2-linux-x64.vsix', sha256: 'b'.repeat(64), size: 100 },
};
const acceptance = {
  schema: 1,
  commit,
  sha256: candidate.package.sha256,
  profile,
  platform: 'linux',
  arch: 'x64',
  omp: '18.21.0',
  vscode: '1.146.0',
  owner: 'qu-gg',
  native: true,
  packaged: true,
  manualSmoke: true,
  scopeExclusionsAcknowledged: true,
  rollback: 'unavailable-first-release',
};
const names = [
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
  'extension/dist/webview/codicon-TEST.ttf',
  '[Content_Types].xml',
  'extension.vsixmanifest',
  ...Object.keys(JSON.parse(readFileSync('quality/playwright-runtime.json', 'utf8')).files).map(
    (name) => `extension/dist/playwright/${name}`,
  ),
  ...['runtime.json', ...ptyRuntimeFiles].map((name) => `extension/dist/pty/${name}`),
];
const entries = () => names.map((name) => ({ name, size: 100, externalFileAttributes: 0 }));

test('release versions require matching package and lock roots without changing identity', () => {
  const lock = { version: '0.0.2', packages: { '': { version: '0.0.2' } } };
  assert.equal(versionTag(manifest, lock), 'v0.0.2');
  assert.throws(() => versionTag(manifest, { ...lock, version: '0.0.1' }));
  assert.throws(() => versionTag({ ...manifest, publisher: 'other' }, lock));
  assert.throws(() => versionTag({ ...manifest, version: '0.0.2-alpha' }, lock));
});

test('release runtime identity accepts the actual pinned OMP CLI and refuses other output', () => {
  assert.deepEqual(validateRuntimeVersions('1.146.0', 'omp/18.21.0'), {
    vscode: '1.146.0',
    omp: '18.21.0',
  });
  for (const output of ['', '18.21.0', 'other/18.21.0', 'omp/18.21.1', 'omp/18.21.0 extra']) {
    assert.throws(() => validateRuntimeVersions('1.146.0', output));
  }
  assert.throws(() => validateRuntimeVersions('', 'omp/18.21.0'));
  assert.throws(() => validateRuntimeVersions('1.146.1', 'omp/18.21.0'));
});

test('private installed/extracted artifacts are not source lint targets; source rules stay enforced', async () => {
  const lint = new ESLint();
  assert.equal(
    await lint.calculateConfigForFile('.local-dev/release/fixture/dist/webview/main.js'),
    undefined,
  );
  assert.equal(
    await lint.calculateConfigForFile('.local-dev/release/fixture/dist/extension.cjs'),
    undefined,
  );
  const source = await lint.calculateConfigForFile('src/terminal.ts');
  assert.equal(source.rules.eqeqeq[0], 2);
  assert.equal(source.rules['no-eval'][0], 2);
});

test('release package allowlist rejects sources, secrets, traversal, duplicates and symlinks', () => {
  validateEntries(entries());
  for (const name of [
    'extension/.env',
    '../escape',
    'extension/node_modules/a.js',
    'extension/src/main.ts',
    'extension/dist/main.js.map',
  ]) {
    assert.throws(() =>
      validateEntries([...entries(), { name, size: 1, externalFileAttributes: 0 }]),
    );
  }
  assert.throws(() => validateEntries(entries().slice(1)));
  assert.throws(() => validateEntries([...entries(), entries()[0]]));
  const linked = entries();
  linked[0].externalFileAttributes = 0o120777 << 16;
  assert.throws(() => validateEntries(linked));
});

test('release package inspection rejects oversized, empty and case-colliding entries', () => {
  const empty = entries();
  empty[0].size = 0;
  assert.throws(() => validateEntries(empty));
  empty[0].size = 17 * 1024 * 1024;
  assert.throws(() => validateEntries(empty));
  assert.throws(() =>
    validateEntries([...entries(), { ...entries()[0], name: 'extension/PACKAGE.json' }]),
  );
});

test('candidate identity is bound to the exact commit, version, checksum and local profile', () => {
  validateCandidate(candidate, manifest, commit);
  for (const changed of [
    { commit: 'c'.repeat(40) },
    { profile: 'remote-ssh' },
    { target: 'win32-x64' },
    { tag: 'latest' },
  ]) {
    assert.throws(() => validateCandidate({ ...candidate, ...changed }, manifest, commit));
  }
  assert.throws(() =>
    validateCandidate(
      { ...candidate, package: { ...candidate.package, file: '../other.vsix' } },
      manifest,
      commit,
    ),
  );
});

test('publication refuses missing, cross-commit, cross-artifact or incomplete local acceptance', () => {
  validateAcceptance(acceptance, candidate);
  assert.throws(() => validateAcceptance({}, candidate));
  for (const key of ['native', 'packaged', 'manualSmoke', 'scopeExclusionsAcknowledged']) {
    assert.throws(() => validateAcceptance({ ...acceptance, [key]: false }, candidate));
  }
  for (const changed of [
    { commit: 'c'.repeat(40) },
    { sha256: 'd'.repeat(64) },
    { profile: 'remote-ssh' },
    { omp: '18.22.0' },
    { owner: 'other' },
    { rollback: 'untested' },
  ]) {
    assert.throws(() => validateAcceptance({ ...acceptance, ...changed }, candidate));
  }
});

test('release notes must be curated for the exact version, not generated from arbitrary commit text', () => {
  const notes = 'Local Linux private alpha. '.repeat(8);
  assert.equal(
    releaseNotes(`# Changelog\n\n## 0.0.2\n\n${notes}\n\n## 0.0.1\n\nOlder.`, '0.0.2'),
    notes.trim(),
  );
  assert.throws(() => releaseNotes('# Changelog\n\n## 0.0.1\n\nOld.', '0.0.2'));
  assert.throws(() => releaseNotes('## 0.0.2\n\nTBD', '0.0.2'));
});

test('release policy keeps remote evidence separate and audit failure blocking', () => {
  const policy = readFileSync('RELEASE.md', 'utf8');
  assert.ok(policy.includes('TODO3 remains open'));
  assert.ok(policy.includes('does not authorize a release'));
  assert.ok(policy.includes('not a cryptographic proof'));
});

test('local acceptance requires explicit manual and rollback acknowledgements', () => {
  assert.equal(
    acceptanceArguments([
      'reports/candidate',
      'reports/acceptance.json',
      '--manual-smoke-passed',
      '--rollback=unavailable-first-release',
    ]).rollback,
    'unavailable-first-release',
  );
  assert.throws(() => acceptanceArguments(['reports/candidate', 'reports/acceptance.json']));
  assert.throws(() =>
    acceptanceArguments([
      'reports/candidate',
      'reports/candidate/acceptance.json',
      '--manual-smoke-passed',
      '--rollback=passed',
    ]),
  );
  assert.throws(() => validateAcceptance({ ...acceptance, secret: 'must not upload' }, candidate));
});

test('candidate runs must be successful owner dispatches from this exact main commit', () => {
  const run = {
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: '.github/workflows/release.yml',
    head_branch: 'main',
    head_sha: commit,
    head_repository: { full_name: 'qu-gg/vs-omp' },
    actor: { login: 'qu-gg' },
  };
  validateRun(run, 'qu-gg/vs-omp', commit);
  for (const changed of [
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { head_sha: 'c'.repeat(40) },
    { path: '.github/workflows/quality.yml' },
    { actor: { login: 'other' } },
    { head_repository: { full_name: 'other/vs-omp' } },
  ]) {
    assert.throws(() => validateRun({ ...run, ...changed }, 'qu-gg/vs-omp', commit));
  }
});

test('real package roots and curated changelog agree on the unreleased version', () => {
  const actual = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(
    versionTag(actual, JSON.parse(readFileSync('package-lock.json', 'utf8'))),
    `v${actual.version}`,
  );
  assert.ok(
    releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), actual.version).includes('Remote-SSH'),
  );
});

test('release workflow is manual-only, audit-blocked and isolates write permissions', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.on.workflow_dispatch.inputs.approve_publication.default, false);
  const jobs = workflow.jobs;
  assert.equal(jobs.publish.permissions.contents, 'write');
  assert.equal(jobs.publish.needs, 'preflight');
  assert.ok(jobs.preflight.if.includes('inputs.approve_publication'));
  for (const name of ['candidate', 'preflight']) {
    assert.ok(jobs[name].if.includes("github.ref == 'refs/heads/main'"));
    assert.ok(jobs[name].steps.some((step) => step.run === 'npm audit --audit-level=moderate'));
    assert.ok(!jobs[name].permissions);
  }
  assert.ok(!jobs.publish.steps.some((step) => /npm|scripts\//.test(step.run || '')));
  for (const job of Object.values(jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      assert.ok(!step['continue-on-error']);
    }
  }
});

async function archiveFixture(context, overrides = {}, packagedManifest = manifest) {
  await copyPtyRuntime();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-release-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const files = Object.fromEntries(names.map((name) => [name, Buffer.from('fixture')]));
  files['extension/package.json'] = Buffer.from(JSON.stringify(packagedManifest));
  files['extension.vsixmanifest'] = Buffer.from(
    `<PackageManifest><Metadata><Identity Id="vs-omp" Publisher="vs-omp-local" Version="${packagedManifest.version}" TargetPlatform="linux-x64"/></Metadata></PackageManifest>`,
  );
  files['extension/LICENSE.txt'] = await readFile('LICENSE');
  files['extension/THIRD_PARTY_NOTICES.txt'] = await readFile('THIRD_PARTY_NOTICES.txt');
  for (const [name, source] of [
    ['monaco-LICENSE.txt', 'node_modules/monaco-editor/LICENSE'],
    ['monaco-ThirdPartyNotices.txt', 'node_modules/monaco-editor/ThirdPartyNotices.txt'],
    ['monaco-marked-LICENSE.txt', 'node_modules/monaco-editor/node_modules/marked/LICENSE.md'],
  ])
    files[`extension/dist/webview/${name}`] = await readFile(source);
  for (const name of names.filter((name) => name.startsWith('extension/dist/playwright/')))
    files[name] = await readFile(
      name.replace('extension/dist/playwright/', 'node_modules/playwright-core/'),
    );
  for (const name of ['runtime.json', ...ptyRuntimeFiles])
    files[`extension/dist/pty/${name}`] = await readFile(`dist/pty/${name}`);
  Object.assign(files, overrides);
  const file = path.join(directory, `vs-omp-${packagedManifest.version}-linux-x64.vsix`);
  const archive = new yazl.ZipFile();
  const done = pipeline(archive.outputStream, createWriteStream(file));
  for (const [name, content] of Object.entries(files))
    archive.addBuffer(Buffer.from(content), name);
  archive.end();
  await done;
  return { directory, file };
}

test('real ZIP inspection binds VSCE canonical names, XML identity and exact upstream notices', async (context) => {
  const fixture = await archiveFixture(context);
  const inspected = await inspectPackage(fixture.file, manifest);
  assert.equal(inspected.file, candidate.package.file);
  assert.match(inspected.sha256, /^[a-f0-9]{64}$/);
  assert.ok(inspected.size > 0);
});

test('real ZIP inspection refuses changed licenses, inconsistent identity and extra files', async (context) => {
  for (const overrides of [
    { 'extension/LICENSE.txt': 'altered license' },
    { 'extension/package.json': JSON.stringify({ ...manifest, version: '0.0.1' }) },
    {
      'extension.vsixmanifest':
        '<PackageManifest><Metadata><Identity Id="vs-omp" Publisher="vs-omp-local" Version="0.0.2" TargetPlatform="win32-x64"/></Metadata></PackageManifest>',
    },
    { 'extension/.env': 'must not package' },
    { 'extension/dist/webview/monaco-LICENSE.txt': 'altered license' },
    { 'extension/dist/webview/monaco-ThirdPartyNotices.txt': 'altered notices' },
    { 'extension/dist/webview/monaco-marked-LICENSE.txt': 'altered license' },
    { 'extension/dist/webview/unapproved-editor.js': 'unapproved editor code' },
    { 'extension/dist/playwright/index.js': 'altered runtime' },
    { 'extension/dist/playwright/unapproved.js': 'extra runtime code' },
    { 'extension/dist/pty/build/Release/pty.node': 'changed native runtime' },
    { 'extension/dist/pty/runtime.json': '{"version":"wrong"}' },
    { 'extension/dist/pty/extra.node': 'unapproved native runtime' },
  ]) {
    const fixture = await archiveFixture(context, overrides);
    await assert.rejects(inspectPackage(fixture.file, manifest));
  }
});

test('candidate directory checks bind checksums and curated notes and reject extra payloads', async (context) => {
  const currentManifest = JSON.parse(await readFile('package.json', 'utf8'));
  const fixture = await archiveFixture(context, {}, currentManifest);
  const actual = {
    ...candidate,
    version: currentManifest.version,
    tag: `v${currentManifest.version}`,
    package: await inspectPackage(fixture.file, currentManifest),
  };
  const notes = releaseNotes(await readFile('CHANGELOG.md', 'utf8'), currentManifest.version);
  await writeFile(path.join(fixture.directory, 'release-candidate.json'), JSON.stringify(actual));
  await writeFile(
    path.join(fixture.directory, 'SHA256SUMS'),
    `${actual.package.sha256}  ${actual.package.file}\n`,
  );
  await writeFile(path.join(fixture.directory, 'release-notes.md'), `${notes}\n`);
  assert.deepEqual(await verifyDirectory(fixture.directory, commit), actual);
  await writeFile(path.join(fixture.directory, 'SHA256SUMS'), 'wrong checksum\n');
  await assert.rejects(verifyDirectory(fixture.directory, commit));
  await writeFile(
    path.join(fixture.directory, 'SHA256SUMS'),
    `${actual.package.sha256}  ${actual.package.file}\n`,
  );
  await writeFile(path.join(fixture.directory, 'unapproved.txt'), 'extra');
  await assert.rejects(verifyDirectory(fixture.directory, commit));
});
