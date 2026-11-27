import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { exchangeMutations, stagePermit } from '../mutations.js';
import { PathGuard, ReviewJournal } from '../review.js';
import type { RequestApproval } from '../approvals.js';
import { fixture, reset, Uri } from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { HostTools } = await import('../host-tools.js');
const { TerminalManager } = await import('../terminal.js');

const requestApproval: RequestApproval = async (prompt) => {
  fixture.warnings.push({
    message: prompt.title,
    detail: prompt.details,
    choices: ['Allow Once', 'Skip'],
  });
  const picked = fixture.onWarning ? await fixture.onWarning() : fixture.approval;
  return picked === 'Approve Once';
};

async function setup(context: TestContext) {
  reset();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-host-tools-'));
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  const abort = new AbortController();
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    {
      read: async () => 'first\nsecond\nthird',
      write: async () => {},
    },
    undefined,
    requestApproval,
  );
  context.after(async () => {
    await tools.finish();
    await rm(cwd, { recursive: true, force: true });
  });
  const scope = {
    sessionId: 'native',
    owner: 'local',
    cwd,
    signal: abort.signal,
    valid: () => true,
  };
  const request = {
    sessionId: 'native',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("approved");'],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  };
  return { tools, scope, request, abort, cwd };
}

test('host tools deny idle/stale access and require command-specific inline approval', async (context) => {
  const { tools, scope, request } = await setup(context);
  await assert.rejects(tools.create(request), /active prompt/);
  tools.begin(scope);
  await assert.rejects(tools.create({ ...request, sessionId: 'stale' }), /active prompt/);
  await assert.rejects(tools.create(request), /not approved/);
  const warning = fixture.warnings[0]!;
  assert.ok(warning.detail!.includes(JSON.stringify(process.execPath)));
  assert.match(warning.detail!, /outside the workspace|not sandboxed/);
  assert.match(warning.detail!, /Keep\/Discard|Source Control/);
  assert.deepEqual(warning.choices, ['Allow Once', 'Skip']);
  fixture.approval = 'Approve Once';
  const owned = { sessionId: 'native', ...(await tools.create(request)) };
  assert.equal((await tools.waitForExit(owned)).exitCode, 0);
  assert.equal(tools.output(owned).output, 'approved');
  await tools.kill(owned);
  await tools.release(owned);
});

test('host execution without an approval surface fails closed', async (context) => {
  const { scope, request } = await setup(context);
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    { read: async () => '', write: async () => {} },
  );
  await tools.run(scope, async () => {
    await assert.rejects(tools.create(request), /not approved/);
  });
});

test('Stop during a native approval prevents late execution and scope reuse', async (context) => {
  const { tools, scope, request, abort, cwd } = await setup(context);
  tools.begin(scope);
  let allow!: (value: string) => void;
  let shown!: () => void;
  const displayed = new Promise<void>((resolve) => {
    shown = resolve;
  });
  fixture.onWarning = () => {
    shown();
    return new Promise<string>((resolve) => {
      allow = resolve;
    });
  };
  const creating = tools.create({
    ...request,
    args: ['-e', 'require("node:fs").writeFileSync("late.txt","bad");'],
  });
  const rejected = assert.rejects(creating, /cancelled|disposed/);
  await displayed;
  abort.abort();
  await rejected;
  await tools.finish();
  allow('Approve Once');
  await assert.rejects(readFile(path.join(cwd, 'late.txt')), { code: 'ENOENT' });
  await assert.rejects(tools.create(request), /active prompt/);
});

test('host command rules auto-approve actual argv and block explicit denies without a dialog', async (context) => {
  const { tools, scope } = await setup(context);
  assert.equal(tools.permissions, 'rules');
  tools.begin(scope);
  const request = { sessionId: scope.sessionId, command: '/bin/pwd' };
  const owned = { sessionId: scope.sessionId, ...(await tools.create(request)) };
  assert.equal((await tools.waitForExit(owned)).exitCode, 0);
  assert.equal(fixture.warnings.length, 0);
  fixture.configuration.set('omp.permissions.commandRules', [{ command: ['pwd'], action: 'deny' }]);
  await assert.rejects(tools.create(request), /blocked by an OMP user rule/);
  assert.equal(fixture.warnings.length, 0);
  fixture.configuration.set('omp.permissions.commandRules', 'malformed');
  await assert.rejects(tools.create(request), /Invalid OMP command rules/);
});

test('permission setter requires explicit elevation, supports revocation and cannot run during a prompt', async (context) => {
  const { tools, scope } = await setup(context);
  assert.equal(tools.permissions, 'rules');
  assert.throws(() => tools.setPermissions('all'), /explicit confirmation/);
  tools.setPermissions('all', true);
  assert.equal(tools.permissions, 'all');
  tools.begin(scope);
  assert.throws(() => tools.setPermissions('ask'), /cleanup/);
  const request = { sessionId: scope.sessionId, command: '/bin/echo', args: ['automatic'] };
  const owned = { sessionId: scope.sessionId, ...(await tools.create(request)) };
  assert.equal((await tools.waitForExit(owned)).exitCode, 0);
  fixture.configuration.set('omp.permissions.commandRules', [{ command: ['echo'], action: 'ask' }]);
  await assert.rejects(tools.create(request), /not approved/);
  await tools.finish();
  tools.resetPermissions();
  assert.equal(tools.permissions, 'rules');
  tools.setPermissions('ask');
  assert.equal(tools.permissions, 'ask');
  fixture.trusted = false;
  assert.throws(() => tools.setPermissions('rules'), /cannot change/);
});

test('an explicit deny added while approval is open prevents a late manual approval', async (context) => {
  const { tools, scope, request } = await setup(context);
  tools.begin(scope);
  fixture.onWarning = async () => {
    fixture.configuration.set('omp.permissions.commandRules', [
      { command: [process.execPath], action: 'deny' },
    ]);
    return 'Approve Once';
  };
  await assert.rejects(tools.create(request), /blocked by an OMP user rule/);
});

test('unsupported and rejected choices never authorize execution or an always-allow grant', async (context) => {
  const { tools, scope, request } = await setup(context);
  tools.begin(scope);
  for (const choice of ['Reject', 'allow_always', 'Open Source Control']) {
    fixture.approval = choice;
    await assert.rejects(tools.create(request), /not approved/);
  }
  assert.equal(fixture.commandCalls.length, 0);
  assert.equal(fixture.logs.length, 0);
});

test('approval revalidates workspace trust, root and active-operation identity', async (context) => {
  const { tools, scope, request } = await setup(context);
  let live = true;
  tools.begin({ ...scope, valid: () => live });
  fixture.onWarning = async () => {
    fixture.trusted = false;
    return 'Approve Once';
  };
  await assert.rejects(tools.create(request), /trusted workspace/);
  fixture.trusted = true;
  fixture.onWarning = async () => {
    live = false;
    return 'Approve Once';
  };
  await assert.rejects(tools.create(request), /active prompt/);
  live = true;
  fixture.roots = [];
  await assert.rejects(tools.create(request), /workspace root/);
});

test('file handlers retain bounded reads and prevent retired async writes from crossing turns', async (context) => {
  const { tools, scope } = await setup(context);
  tools.begin(scope);
  assert.equal(
    await tools.read({ sessionId: 'native', path: '/test.txt', line: 2, limit: 1 }),
    'second',
  );
  assert.throws(() => tools.begin(scope), /previous tool scope/i);
  assert.throws(() => tools.output({ sessionId: 'native', terminalId: 'guessed' }), /No terminal/);
  await tools.write({ sessionId: 'native', path: '/test.txt', content: 'new' });
  await tools.finish();
  let normalize!: (value: string) => void;
  let writes = 0;
  const isolated = new HostTools(
    {
      normalize: () =>
        new Promise<string>((resolve) => {
          normalize = resolve;
        }),
    },
    {
      read: async () => '',
      write: async () => {
        writes++;
      },
    },
  );
  isolated.begin(scope);
  const pending = isolated.write({ sessionId: 'native', path: '/test.txt', content: 'old' });
  await isolated.finish();
  isolated.begin(scope);
  normalize('old');
  await assert.rejects(pending, /retired prompt/);
  assert.equal(writes, 0);
  await isolated.finish();
});

test('native approval escapes invisible control characters rather than hiding command text', async (context) => {
  const { tools, scope, request } = await setup(context);
  tools.begin(scope);
  const control = String.fromCharCode(0x202e);
  await assert.rejects(
    tools.create({ ...request, args: ['-e', '', `visible${control}hidden\nline`] }),
    /not approved/,
  );
  const detail = fixture.warnings[0]!.detail!;
  assert.ok(detail.includes('visible\\u202ehidden\\nline'));
  assert.ok(!detail.includes(control));
});

test('cleanup errors latch the controller closed and remain observable on repeated finish', async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-host-cleanup-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  reset();
  fixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  fixture.approval = 'Approve Once';
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    { read: async () => '', write: async () => {} },
    undefined,
    requestApproval,
  );
  const scope = {
    sessionId: 'native',
    owner: 'local',
    cwd,
    signal: new AbortController().signal,
    valid: () => true,
  };
  tools.begin(scope);
  const handle = await tools.create({
    sessionId: 'native',
    command: process.execPath,
    args: ['-e', ''],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  });
  await tools.waitForExit({ sessionId: 'native', ...handle });
  const dispose = TerminalManager.prototype.dispose;
  context.mock.method(
    TerminalManager.prototype,
    'dispose',
    async function (this: InstanceType<typeof TerminalManager>) {
      await dispose.call(this);
      throw new Error('injected cleanup failure');
    },
  );
  await assert.rejects(tools.finish(), /cleanup failed/);
  await assert.rejects(tools.finish(), /cleanup failed/);
  assert.throws(() => tools.begin(scope), /not closed safely/);
});

test('host prompt brokers native images and permits only the exact one-shot call', async (context) => {
  const { scope, cwd } = await setup(context);
  process.env.VS_OMP_ARTIFACTS_ROOT = path.join(cwd, 'private');
  context.after(() => delete process.env.VS_OMP_ARTIFACTS_ROOT);
  const directory = path.join(cwd, 'private', 'mutations');
  const writes: unknown[] = [];
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    {
      read: async () => '',
      write: async (...args) => {
        writes.push(args);
      },
    },
    directory,
  );
  await tools.run(scope, async () => {
    await exchangeMutations(directory, [
      { op: 'write', path: path.join(cwd, 'file.txt'), before: 'old', content: 'new' },
    ]);
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as unknown[])[0], scope.owner);
    const id = randomUUID();
    await stagePermit(directory, id, 'exact input');
    const request = {
      sessionId: scope.sessionId,
      toolCall: { toolCallId: id, rawInput: { input: 'wrong input' } },
      options: [{ kind: 'allow_once' as const, optionId: 'once', name: 'Once' }],
    };
    assert.equal((await tools.permission(request)).outcome.outcome, 'cancelled');
    const exact = {
      ...request,
      toolCall: { ...request.toolCall, rawInput: { input: 'exact input' } },
    };
    assert.deepEqual((await tools.permission(exact)).outcome, {
      outcome: 'selected',
      optionId: 'once',
    });
    assert.equal((await tools.permission(exact)).outcome.outcome, 'cancelled');
    assert.equal(
      (await tools.permission({ ...request, options: [] })).outcome.outcome,
      'cancelled',
    );
    const shellId = `call_${randomUUID()}|../../${'opaque/+'.repeat(70)}`;
    const command = 'ls -la';
    await stagePermit(directory, shellId, JSON.stringify({ command }));
    assert.ok(
      (await readdir(directory))
        .filter((file) => file.startsWith('permit-'))
        .every((file) => /^permit-[a-f0-9]{64}\.json$/.test(file)),
    );
    const shell = {
      ...request,
      toolCall: {
        toolCallId: shellId,
        rawInput: { command, timeout: null, cwd, pty: false },
      },
    };
    assert.deepEqual((await tools.permission(shell)).outcome, {
      outcome: 'selected',
      optionId: 'once',
    });
    assert.equal((await tools.permission(shell)).outcome.outcome, 'cancelled');
  });
});

test('outside read authorization includes directories and is consumed once by text reads', async (context) => {
  const { scope, cwd } = await setup(context);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'omp-outside-read-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'arbitrary.extension');
  await writeFile(target, 'outside text');
  await mkdir(path.join(outside, 'folder'));
  let allowed = false;
  const approvals: string[] = [];
  const journal = new ReviewJournal(
    { read: (target) => readFile(target, 'utf8'), replace: async () => {} },
    new PathGuard([cwd]),
    async (operation) => {
      approvals.push(operation.path);
      return allowed;
    },
    async () => {},
  );
  const directory = path.join(cwd, 'private', 'mutations');
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    journal,
    directory,
  );
  await tools.run(scope, async () => {
    await assert.rejects(
      exchangeMutations(directory, [{ op: 'access', path: outside }]),
      /not approved/,
    );
    allowed = true;
    await exchangeMutations(directory, [{ op: 'access', path: path.join(outside, 'folder') }]);
    await exchangeMutations(directory, [{ op: 'access', path: target }]);
    assert.equal(await tools.read({ sessionId: scope.sessionId, path: target }), 'outside text');
    assert.equal(approvals.length, 3);
    allowed = false;
    await assert.rejects(tools.read({ sessionId: scope.sessionId, path: target }), /not approved/);
  });
  await assert.rejects(tools.read({ sessionId: scope.sessionId, path: target }), /active prompt/);
});

test('host brokers read/delete/move preimages and rejects executable side effects and missing adapters', async (context) => {
  const { scope, cwd } = await setup(context);
  process.env.VS_OMP_ARTIFACTS_ROOT = path.join(cwd, 'private');
  context.after(() => delete process.env.VS_OMP_ARTIFACTS_ROOT);
  const directory = path.join(cwd, 'private', 'mutations');
  const calls: unknown[] = [];
  const journal = {
    read: async () => '',
    write: async () => {},
    inspect: async () => 'original',
    delete: async (...args: unknown[]) => {
      calls.push(args);
    },
    move: async (...args: unknown[]) => {
      calls.push(args);
    },
  };
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    journal,
    directory,
  );
  const target = path.join(cwd, 'source.txt');
  const move = {
    op: 'move' as const,
    path: target,
    before: 'original',
    content: 'moved',
    destination: path.join(cwd, 'destination.txt'),
  };
  await tools.run(scope, async () => {
    await exchangeMutations(directory, [
      { op: 'read', path: target },
      { op: 'delete', path: target, before: 'original' },
      move,
    ]);
    assert.equal(calls.length, 2);
    await assert.rejects(
      exchangeMutations(directory, [{ ...move, content: '#!/bin/sh' }]),
      /Executable-bit/,
    );
    await assert.rejects(
      exchangeMutations(directory, [{ op: 'write', path: target, before: null, content: '#!' }]),
      /Executable-bit/,
    );
    await exchangeMutations(directory, [
      { op: 'write', path: target, before: null, content: 'const marker = "#!";\n' },
    ]);
    await exchangeMutations(directory, [{ ...move, content: 'moved "#!" marker' }]);
  });
  const missing = new HostTools(
    { normalize: async (_target, content) => content },
    { read: journal.read, write: journal.write },
    directory,
  );
  await missing.run(scope, async () => {
    for (const mutation of [
      { op: 'read' as const, path: target },
      { op: 'delete' as const, path: target, before: 'original' },
      move,
    ])
      await assert.rejects(exchangeMutations(directory, [mutation]), /journal is unavailable/);
  });
});

test('native writes refuse a dirty open buffer before staging review', async (context) => {
  const { scope, cwd } = await setup(context);
  process.env.VS_OMP_ARTIFACTS_ROOT = path.join(cwd, 'private');
  context.after(() => delete process.env.VS_OMP_ARTIFACTS_ROOT);
  const directory = path.join(cwd, 'private', 'mutations');
  const target = path.join(cwd, 'dirty.txt');
  await writeFile(target, 'before');
  const writes: unknown[] = [];
  const tools = new HostTools(
    {
      normalize: async (_target, content) => content,
      isDirty: (candidate) => candidate === target,
    },
    {
      read: async () => '',
      write: async (...args) => {
        writes.push(args);
      },
    },
    directory,
  );
  await tools.run(scope, async () => {
    await assert.rejects(
      exchangeMutations(directory, [
        { op: 'write', path: target, before: 'before', content: 'after' },
      ]),
      /dirty buffer/,
    );
  });
  await assert.rejects(exchangeMutations(directory, []), /ENOENT/);
});
