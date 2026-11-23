import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';

export function headingAnchors(tokens) {
  const anchors = new Set();
  const repeats = new Map();
  const document = JSDOM.fragment(marked.parser(tokens));
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = heading.textContent
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, '')
      .replace(/ /g, '-');
    const count = repeats.get(base) || 0;
    repeats.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const element of document.querySelectorAll('[id],a[name]'))
    anchors.add(element.getAttribute('id') || element.getAttribute('name'));
  return anchors;
}

export function validateMarkdown(file, source, files, load) {
  const base = pathToFileURL(path.resolve(file));
  let links = 0;
  const document = JSDOM.fragment(marked.parse(source));
  for (const element of document.querySelectorAll('a[href],img[src]')) {
    const href = element.getAttribute(element.localName === 'a' ? 'href' : 'src');
    const target = new URL(href, base);
    if (target.protocol !== 'file:') {
      assert.ok(
        ['https:', 'http:', 'mailto:'].includes(target.protocol),
        `${file}: unsupported link scheme`,
      );
      continue;
    }
    const relative = path.relative(process.cwd(), fileURLToPath(target)).split(path.sep).join('/');
    assert.ok(files.has(relative), `${file}: unpublished target ${href}`);
    assert.ok(
      !/^(reports|\.local-dev|dist|node_modules|\.quality-build|\.spike)\//.test(relative),
      `${file}: private target`,
    );
    if (target.hash && relative.endsWith('.md')) {
      const anchors = headingAnchors(marked.lexer(load(relative)));
      assert.ok(
        anchors.has(decodeURIComponent(target.hash.slice(1))),
        `${file}: missing heading ${href}`,
      );
    }
    links++;
  }
  return links;
}

export function validateForkWorkflow(workflow) {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(!JSON.stringify(workflow).includes('secrets.'), 'Fork CI must not require secrets');
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(
      !job.permissions ||
        Object.values(job.permissions).every((value) => ['read', 'none'].includes(value)),
    );
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@'))
        assert.equal(step.with['persist-credentials'], false);
      assert.ok(!step['continue-on-error']);
      assert.ok(
        !/test:live|spike:|release:accept|gh release|pull_request_target/.test(step.run || ''),
      );
    }
  }
}

export function validateTaskLedger(source) {
  const ids = new Set();
  const anchors = headingAnchors(marked.lexer(source));
  const tasks = [];
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type !== 'table' || token.header[0]?.text !== 'ID') return;
    for (const row of token.rows) {
      const fields = row.map((cell) =>
        JSDOM.fragment(marked.parseInline(cell.text)).textContent.trim(),
      );
      const [id, state, task, check] = fields;
      assert.equal(fields.length, 4, 'Tasks require ID/state/task/completion columns');
      assert.match(id, /^[A-Z][A-Z0-9]*-\d{2}(?:-\d+)?$/);
      assert.ok(!ids.has(id), `Duplicate task ID: ${id}`);
      assert.ok(anchors.has(id.toLowerCase()), `Missing stable task anchor: ${id}`);
      assert.ok(
        ['verified', 'open', 'research', 'blocked'].includes(state),
        `Unknown task state: ${id}`,
      );
      assert.ok(task.length >= 12 && check.length >= 20, `Unbounded or empty task: ${id}`);
      if (state === 'verified')
        assert.ok(
          row[3].tokens.some((entry) => entry.type === 'link'),
          `Verified task needs linked evidence: ${id}`,
        );
      ids.add(id);
      tasks.push({ id, state, task, check });
    }
  });
  assert.ok(tasks.length > 0, 'No atomic task rows');
  return tasks;
}

function publicationFiles() {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, 'Cannot enumerate publication files');
  return new Set(result.stdout.split('\0').filter((file) => file && existsSync(file)));
}

export function validateScreenshot(bytes, expected) {
  assert.ok(bytes.length >= 33 && bytes.length <= 4 * 1024 * 1024);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  assert.equal(bytes.readUInt32BE(16), expected.width);
  assert.equal(bytes.readUInt32BE(20), expected.height);
  let offset = 8;
  const chunks = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length);
    const length = bytes.readUInt32BE(offset);
    assert.ok(length <= bytes.length - offset - 12);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(['IHDR', 'IDAT', 'IEND'].includes(kind), 'Unexpected PNG metadata');
    chunks.push(kind);
    offset += length + 12;
  }
  assert.equal(chunks[0], 'IHDR');
  assert.equal(chunks.at(-1), 'IEND');
  assert.ok(chunks.includes('IDAT'));
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory() && directory === '.') return [];
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

export function checkPublic() {
  const files = publicationFiles();
  const docs = [
    ...markdownFiles('.'),
    ...markdownFiles('docs'),
    '.github/PULL_REQUEST_TEMPLATE.md',
  ];
  const load = (file) => readFileSync(file, 'utf8');
  const links = docs.reduce(
    (total, file) => total + validateMarkdown(file, load(file), files, load),
    0,
  );
  const manifest = JSON.parse(load('package.json'));
  const taskCount = validateTaskLedger(load('TODO.md')).length;
  const provenance = JSON.parse(load('docs/images/provenance.json'));
  assert.equal(provenance.schema, 1);
  assert.equal(provenance.realInferenceRequests, 0);
  assert.deepEqual(provenance.transformations, []);
  const imageNames = provenance.images.map((image) => image.file);
  assert.deepEqual(
    imageNames.sort(),
    readdirSync('docs/images')
      .filter((file) => file.endsWith('.png'))
      .sort(),
  );
  for (const image of provenance.images) {
    assert.match(image.file, /^[a-z-]+\.png$/);
    const file = `docs/images/${image.file}`;
    assert.ok(files.has(file), `Unpublished screenshot: ${file}`);
    validateScreenshot(readFileSync(file), image);
  }
  assert.equal(manifest.displayName, 'Linewise');
  assert.equal(manifest.name, 'vs-omp');
  assert.equal(manifest.publisher, 'vs-omp-local');
  assert.equal(manifest.private, true);
  assert.ok(manifest.contributes.commands.every((entry) => entry.command.startsWith('omp.')));
  validateForkWorkflow(parse(load('.github/workflows/quality.yml')));
  for (const file of ['bug.yml', 'feature.yml']) {
    const form = parse(load(`.github/ISSUE_TEMPLATE/${file}`));
    assert.ok(form.name && form.description && form.body.length >= 3);
    assert.ok(form.body.some((field) => field.validations?.required));
  }
  console.log(
    `Public checks passed: ${docs.length} Markdown files, ${links} local links, ${taskCount} atomic tasks, stable identity, fork-safe CI and issue forms.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkPublic();
