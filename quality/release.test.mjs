import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { validateDestination, validateMaintainer, validateRun } from '../scripts/release-run.mjs';
import { parse } from 'yaml';
import { copyPtyRuntime, ptyRuntimeFiles } from '../scripts/pty-runtime.mjs';
import {
  headingAnchors,
  validateForkWorkflow,
  validateMarkdown,
  validateScreenshot,
  validateTaskLedger,
} from '../scripts/public-check.mjs';
import { marked } from 'marked';

const manifest = { name: 'vs-omp', publisher: 'vs-omp-local', version: '0.1.0', license: 'MIT' };
const commit = 'a'.repeat(40);
const candidate = {
  schema: 1,
  commit,
  version: '0.1.0',
  tag: 'v0.1.0',
  profile,
  target: 'linux-x64',
  package: { file: 'vs-omp-0.1.0-linux-x64.vsix', sha256: 'b'.repeat(64), size: 100 },
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
  'extension/docs/images/icon-building/line-decisions.png',
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
  const lock = { version: '0.1.0', packages: { '': { version: '0.1.0' } } };
  assert.equal(versionTag(manifest, lock), 'v0.1.0');
  assert.throws(() => versionTag(manifest, { ...lock, version: '0.0.1' }));
  assert.throws(() => versionTag({ ...manifest, publisher: 'other' }, lock));
  assert.throws(() => versionTag({ ...manifest, version: '0.1.0-alpha' }, lock));
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
  const wrongFile = { ...candidate, package: { ...candidate.package, file: '../other.vsix' } };
  assert.throws(() => validateCandidate(wrongFile, manifest, commit));
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
    releaseNotes(`# Changelog\n\n## 0.1.0\n\n${notes}\n\n## 0.0.1\n\nOlder.`, '0.1.0'),
    notes.trim(),
  );
  assert.throws(() => releaseNotes('# Changelog\n\n## 0.0.1\n\nOld.', '0.1.0'));
  assert.throws(() => releaseNotes('## 0.1.0\n\nTBD', '0.1.0'));
});

test('release policy keeps remote evidence separate and audit failure blocking', () => {
  const policy = readFileSync('RELEASE.md', 'utf8');
  assert.ok(policy.includes('Remote-SSH remains unvalidated'));
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
    head_repository: { full_name: 'qu-gg/linewise' },
    actor: { login: 'qu-gg' },
  };
  validateRun(run, 'qu-gg/linewise', commit);
  for (const changed of [
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { head_sha: 'c'.repeat(40) },
    { path: '.github/workflows/quality.yml' },
    { actor: { login: 'other' } },
    { head_repository: { full_name: 'qu-gg/vs-omp' } },
  ]) {
    assert.throws(() => validateRun({ ...run, ...changed }, 'qu-gg/linewise', commit));
  }
});

test('release authority is explicit and visibility cannot change or fall back', () => {
  const repository = 'qu-gg/linewise';
  const repo = { full_name: repository, default_branch: 'main', private: false };
  validateDestination(repo, repository, commit, commit, 'public');
  validateDestination({ ...repo, private: true }, repository, commit, commit, 'private');
  for (const changed of [
    { full_name: 'qu-gg/vs-omp' },
    { default_branch: 'next' },
    { private: true },
  ])
    assert.throws(() =>
      validateDestination({ ...repo, ...changed }, repository, commit, commit, 'public'),
    );
  assert.throws(() => validateDestination(repo, repository, commit, commit, undefined));
  assert.throws(() => validateDestination(repo, repository, commit, 'c'.repeat(40), 'public'));
  validateMaintainer('second', { maintainers: ['second'] });
  assert.throws(() => validateMaintainer('other'));
});

test('public screenshot provenance rejects changed pixels, dimensions and extra metadata', () => {
  const ledger = JSON.parse(readFileSync('docs/images/provenance.json', 'utf8'));
  const image = ledger.images[0];
  const bytes = readFileSync(`docs/images/${image.file}`);
  validateScreenshot(bytes, image);
  assert.throws(() => validateScreenshot(bytes, { ...image, width: image.width + 1 }));
  const changed = Buffer.from(bytes);
  changed[40] ^= 1;
  assert.throws(() => validateScreenshot(changed, image));
  const metadata = Buffer.from(bytes);
  metadata.write('tEXt', 37, 'ascii');
  const digest = createHash('sha256').update(metadata).digest('hex');
  assert.throws(() => validateScreenshot(metadata, { ...image, sha256: digest }));
});

test('public Markdown rejects private/missing targets and verifies same-file headings', () => {
  const file = 'README.md';
  const files = new Set([file, 'docs/usage.md']);
  const load = () => '# Example\n\n## Repeated\n\n## Repeated\n';
  assert.equal(validateMarkdown(file, '# Example\n\n[here](#example)', files, load), 1);
  assert.deepEqual(
    [...headingAnchors(marked.lexer(load()))],
    ['example', 'repeated', 'repeated-1'],
  );
  for (const link of [
    'reports/private.json',
    '.local-dev/runbook.md',
    'missing.md',
    '#absent',
    'javascript:alert(1)',
    '/etc/passwd',
  ])
    assert.throws(() => validateMarkdown(file, `[bad](${link})`, files, load));
  files.add('reports/private.json');
  assert.throws(() => validateMarkdown(file, '[private](reports/private.json)', files, load));
});

test('public HTML validates image links, decoded attributes and explicit or generated anchors', () => {
  const files = new Set(['README.md', 'docs/image.png', 'docs/a&b.md']);
  const source = '<h1 align="center">Linewise</h1><a id="ssh-01"></a>';
  const check = (html) => validateMarkdown('README.md', html, files, () => source);
  const markup = `${source}<a href="#linewise">top</a><a href="#ssh-01">task</a><img src="docs/image.png"><a href="docs/a&amp;b.md">doc</a>`;
  assert.equal(check(markup), 4);
  for (const href of ['.local-dev/runbook.md', '#absent', 'javascript&#58;alert(1)'])
    assert.throws(() => check(`<a href="${href}">bad</a>`));
  assert.throws(() => check('<img src="missing.png">'));
  assert.equal(check('```html\n<img src="missing.png">\n```'), 0);
});
test('shared ledger rejects duplicate IDs, missing anchors, invalid states and unsupported verification', () => {
  const header = '| ID | State | Atomic Task | Completion Check |\n| --- | --- | --- | --- |\n';
  const row =
    '| <a id="ssh-01"></a> `SSH-01` | research | Establish remote host placement | Record actual host/process identities and public API boundaries. |\n';
  assert.equal(validateTaskLedger(header + row).length, 1);
  const accessible = row.replaceAll('SSH-01', 'A11Y-01').replaceAll('ssh-01', 'a11y-01');
  assert.equal(validateTaskLedger(header + accessible).length, 1);
  for (const source of [
    header + row + row,
    header + row.replace('research', 'done'),
    header + row.replace('<a id="ssh-01"></a>', ''),
    header + row.replace('research', 'verified'),
    header + row.replace('Record actual host/process identities and public API boundaries.', ''),
  ])
    assert.throws(() => validateTaskLedger(source));
});

test('fork CI rejects write authority, secret requirements, unpinned actions and model calls', () => {
  const workflow = parse(readFileSync('.github/workflows/quality.yml', 'utf8'));
  validateForkWorkflow(workflow);
  for (const modify of [
    (copy) => {
      copy.on.pull_request_target = {};
    },
    (copy) => {
      copy.permissions.contents = 'write';
    },
    (copy) => {
      copy.jobs.quality.permissions = { contents: 'write' };
    },
    (copy) => {
      copy.jobs.quality.steps.push({ run: 'npm run test:live' });
    },
    (copy) => {
      copy.jobs.quality.steps.push({ run: '${{ secrets.PROVIDER }}' });
    },
    (copy) => {
      copy.jobs.quality.steps.push({ uses: 'actions/checkout@main' });
    },
  ]) {
    const copy = structuredClone(workflow);
    modify(copy);
    assert.throws(() => validateForkWorkflow(copy));
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
  assert.equal(workflow.on.workflow_dispatch.inputs.visibility.default, 'private');
  const jobs = workflow.jobs;
  assert.equal(jobs.publish.permissions.contents, 'write');
  assert.equal(jobs.publish.needs, 'preflight');
  assert.equal(jobs.publish.environment, 'linewise-release');
  assert.equal(jobs.authorize.permissions, undefined);
  assert.ok(
    jobs.authorize.steps.some((step) => step.run === 'node scripts/release-run.mjs authorize'),
  );
  assert.ok(jobs.preflight.if.includes('inputs.approve_publication'));
  for (const name of ['candidate', 'preflight']) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-24.04');
    assert.ok(jobs[name].if.includes("github.ref == 'refs/heads/main'"));
    assert.equal(jobs[name].needs, 'authorize');
    assert.ok(jobs[name].if.includes("needs.authorize.outputs.allowed == 'true'"));
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
  files['extension/docs/images/icon-building/line-decisions.png'] = await readFile(
    'docs/images/icon-building/line-decisions.png',
  );
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
        '<PackageManifest><Metadata><Identity Id="vs-omp" Publisher="vs-omp-local" Version="0.1.0" TargetPlatform="win32-x64"/></Metadata></PackageManifest>',
    },
    { 'extension/.env': 'must not package' },
    { 'extension/docs/images/icon-building/line-decisions.png': 'altered logo' },
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
