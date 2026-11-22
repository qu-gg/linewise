import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { register } from 'node:module';
import type * as vscode from 'vscode';
import { window } from './vscode-fixture.js';
import { fixture as hostFixture, Uri } from './vscode-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exchangeResult } from '../mutations.js';
register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const { createHostTerminal, pickOwnedTerminal } = await import('../host-terminals.js');
import { TerminalManager } from '../terminal.js';
const { HostTools } = await import('../host-tools.js');

function fixture(
  context: TestContext,
  command = 'printf READY; IFS= read -r value',
  ptyMode = true,
) {
  let pty!: vscode.Pseudoterminal;
  const shown: boolean[] = [];
  let disposed = 0;
  const ui = {
    show: (preserve: boolean) => shown.push(preserve),
    dispose: () => {
      disposed++;
      pty.close();
    },
  };
  context.mock.method(window, 'createTerminal', (options: unknown) => {
    pty = (options as vscode.ExtensionTerminalOptions).pty;
    return ui;
  });
  const abort = new AbortController();
  const terminal = createHostTerminal(
    {
      command: '/bin/bash',
      args: ['-c', command],
      cwd: process.cwd(),
      env: {},
      outputByteLimit: 65536,
    },
    null,
    { pty: ptyMode, visibility: 'background' },
    { signal: abort.signal, valid: () => true },
  )!;
  context.after(async () => {
    terminal.terminate('fixture-cleanup');
    await terminal.done;
  });
  return { terminal, pty: () => pty, shown, ui, abort, disposed: () => disposed };
}

test('public terminal adapter preserves focus and blocks unapproved ordinary input', async (context) => {
  const { terminal, pty, shown } = fixture(context);
  assert.deepEqual(shown, []);
  pty().open({ columns: 100, rows: 30 });
  await terminal.ready;
  assert.equal((await terminal.waitForOutput(3000)).output, 'READY');
  pty().handleInput!('not-delivered\r');
  terminal.reveal!();
  assert.deepEqual(shown, [false]);
  terminal.terminate('stop');
  assert.notEqual((await terminal.done).exitCode, 0);
});

test('production takeover waits for confirmation and real completion without capturing input', async (context) => {
  let resume!: (choice: string) => void;
  context.mock.method(
    window,
    'showInformationMessage',
    () =>
      new Promise<string>((resolve) => {
        resume = resolve;
      }),
  );
  const { terminal, pty } = fixture(context);
  pty().open(undefined);
  await terminal.waitForOutput(3000);
  let returned = false;
  const hold = terminal.takeover!().then(() => {
    returned = true;
  });
  resume('Resume Agent');
  await Promise.resolve();
  assert.equal(returned, false);
  pty().handleInput!('synthetic-only\r');
  await hold;
  assert.equal(returned, true);
  assert.equal(terminal.snapshot().output, '');
});

test('closing before public terminal open settles startup and completion', async (context) => {
  const { terminal, pty, disposed } = fixture(context);
  pty().close();
  await assert.rejects(terminal.ready, /before startup/);
  assert.notEqual((await terminal.done).exitCode, 0);
  assert.equal(disposed(), 1);
  pty().open(undefined);
});

test('closing a terminal settles takeover even when its confirmation stays unresolved', async (context) => {
  context.mock.method(window, 'showInformationMessage', () => new Promise<string>(() => {}));
  const { terminal, pty } = fixture(context);
  pty().open(undefined);
  await terminal.waitForOutput(3000);
  const hold = terminal.takeover!();
  void hold.catch(() => {});
  pty().close();
  await assert.rejects(hold, /cancelled/);
  assert.notEqual((await terminal.done).exitCode, 0);
});

test('dismissed production confirmation cancels rather than resuming the command', async (context) => {
  context.mock.method(window, 'showInformationMessage', async () => undefined);
  const { terminal, pty } = fixture(context);
  pty().open(undefined);
  await terminal.waitForOutput(3000);
  await assert.rejects(terminal.takeover!(), /cancelled/);
  assert.notEqual((await terminal.done).exitCode, 0);
  assert.equal(terminal.snapshot().output, '');
});

for (const failure of ['reveal', 'notification'] as const)
  test(`takeover ${failure} failure stops owned input and latches rejection`, async (context) => {
    const { terminal, pty, ui } = fixture(context);
    const unavailable = () => {
      throw new Error('Fixture host UI unavailable');
    };
    if (failure === 'reveal') context.mock.method(ui, 'show', unavailable);
    else context.mock.method(window, 'showInformationMessage', unavailable);
    pty().open(undefined);
    assert.equal((await terminal.waitForOutput(3000)).output, 'READY');
    await assert.rejects(terminal.takeover!(), /Fixture host UI unavailable/);
    assert.ok(terminal.snapshot().exitStatus);
    assert.notEqual(terminal.snapshot().exitStatus!.exitCode, 0);
    await assert.rejects(terminal.waitForHandback!(), /Fixture host UI unavailable/);
    pty().handleInput!('ignored-after-ui-failure\r');
    assert.equal(terminal.snapshot().output, '');
  });

test('command completion alone cannot resume production takeover', async (context) => {
  let resume!: (choice: string) => void;
  context.mock.method(
    window,
    'showInformationMessage',
    () =>
      new Promise<string>((resolve) => {
        resume = resolve;
      }),
  );
  const { terminal, pty } = fixture(context);
  pty().open(undefined);
  await terminal.waitForOutput(3000);
  let returned = false;
  const hold = terminal.takeover!().then(() => {
    returned = true;
  });
  pty().handleInput!('synthetic-only\r');
  await terminal.done;
  assert.equal(returned, false);
  resume('Resume Agent');
  await hold;
  assert.equal(returned, true);
});

test('visible pipe output and Ctrl+C do not grant ordinary interactive input', async (context) => {
  const { terminal, pty } = fixture(context, 'printf READY; exec tail -f /dev/null', false);
  let displayed = '';
  pty().onDidWrite((text) => {
    displayed += text;
  });
  pty().open(undefined);
  await terminal.waitForOutput(3000);
  pty().handleInput!('blocked');
  assert.equal(displayed, 'READY');
  await assert.rejects(terminal.takeover!(), /not available/);
  pty().handleInput!('\x03');
  assert.notEqual((await terminal.done).exitCode, 0);
  pty().handleInput!('\x03');
});

test('host broker routes approved visible PTY commands through current prompt ownership', async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-host-pty-'));
  const previous = hostFixture.roots;
  hostFixture.roots = [{ name: 'workspace', uri: Uri.file(cwd), index: 0 }];
  context.mock.method(window, 'createTerminal', (options: unknown) => {
    const pty = (options as vscode.ExtensionTerminalOptions).pty;
    queueMicrotask(() => pty.open(undefined));
    return { show: () => {}, dispose: () => pty.close() };
  });
  let approvals = 0;
  const directory = path.join(cwd, 'private', 'mutations');
  const tools = new HostTools(
    { normalize: async (_target, content) => content },
    { read: async () => '', write: async () => {} },
    directory,
    async () => {
      approvals++;
      return true;
    },
  );
  context.after(async () => {
    await tools.finish();
    hostFixture.roots = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  await tools.run(
    {
      sessionId: 'native',
      owner: 'local',
      cwd,
      signal: new AbortController().signal,
      valid: () => true,
    },
    async () => {
      const results = await exchangeResult(directory, [
        {
          op: 'shell',
          request: {
            command: 'printf HOST_PTY',
            pty: true,
            visibility: 'background',
            action: 'start',
          },
        },
      ]);
      const request = { sessionId: 'native', terminalId: JSON.parse(results!).jobId };
      await tools.waitForExit(request);
      assert.equal((await tools.output(request)).output, 'HOST_PTY');
      context.mock.method(
        window,
        'showQuickPick',
        async (items: Parameters<typeof window.showQuickPick>[0]) =>
          items.find((item) => item.value === 'reveal') ?? items[0],
      );
      await tools.pickTerminal();
      context.mock.method(window, 'showQuickPick', async () => undefined);
      let restored = 0;
      await tools.pickTerminal((sessionId) => {
        assert.equal(sessionId, 'native');
        restored++;
      });
      assert.equal(restored, 1);
    },
  );
  assert.equal(approvals, 1);
});

test('owned terminal picker rejects stale or missing handles without adopting any terminal', async (context) => {
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    approve: async () => true,
  });
  context.after(() => manager.dispose());
  await assert.rejects(
    pickOwnedTerminal(manager, 'owner', () => {}),
    /No integrated terminal/,
  );
  await assert.rejects(
    pickOwnedTerminal(manager, 'owner', () => {
      throw new Error('stale');
    }),
    /stale/,
  );
});

test('duplicate takeover cannot replace an active confirmation or bypass hand-back', async (context) => {
  let resume!: (choice: string) => void;
  context.mock.method(
    window,
    'showInformationMessage',
    () =>
      new Promise<string>((resolve) => {
        resume = resolve;
      }),
  );
  const { terminal, pty } = fixture(context);
  pty().open(undefined);
  await terminal.waitForOutput(3000);
  const hold = terminal.takeover!();
  await assert.rejects(terminal.takeover!(), /already pending/);
  const handback = terminal.waitForHandback!();
  pty().handleInput!('synthetic-only\r');
  await terminal.done;
  resume('Resume Agent');
  await hold;
  await handback;
  await terminal.waitForHandback!();
});

test('public terminal display output is bounded and overflow stops the owned process', async (context) => {
  const { terminal, pty } = fixture(context, 'yes DISPLAY_OUTPUT');
  let bytes = 0;
  pty().onDidWrite((text) => {
    bytes += Buffer.byteLength(text, 'utf8');
  });
  pty().open(undefined);
  const status = await terminal.done;
  assert.ok(bytes > 0 && bytes <= 1024 * 1024);
  assert.equal(status._meta?.['vs-omp/termination'], 'terminal-output-limit');
  assert.notEqual(status.exitCode, 0);
});

test('suppressed takeover output remains bounded and late input cannot reopen capture', async (context) => {
  context.mock.method(window, 'showInformationMessage', async () => 'Resume Agent');
  const { terminal, pty } = fixture(
    context,
    'printf READY; IFS= read -r value; yes HUMAN_DISPLAY_ONLY',
  );
  pty().open(undefined);
  assert.equal((await terminal.waitForOutput(3000)).output, 'READY');
  const hold = terminal.takeover!();
  pty().handleInput!('fixture-only\r');
  await hold;
  const status = await terminal.done;
  assert.equal(status._meta?.['vs-omp/termination'], 'terminal-output-limit');
  assert.notEqual(status.exitCode, 0);
  const captured = terminal.snapshot();
  assert.equal(captured.output, '');
  assert.equal(captured._meta?.['vs-omp/capture'], 'withheld-after-takeover');
  assert.doesNotThrow(() => pty().handleInput!('ignored-after-cleanup\r'));
  assert.deepEqual(terminal.snapshot(), captured);
});

test('dismissal after process success stays rejected for all late completion waits', async (context) => {
  let dismiss!: (choice: string | undefined) => void;
  context.mock.method(
    window,
    'showInformationMessage',
    () =>
      new Promise<string | undefined>((resolve) => {
        dismiss = resolve;
      }),
  );
  const { terminal, pty } = fixture(context);
  pty().open(undefined);
  await terminal.waitForOutput(3000);
  const hold = terminal.takeover!();
  pty().handleInput!('synthetic-only\r');
  assert.equal((await terminal.done).exitCode, 0);
  dismiss(undefined);
  await assert.rejects(hold, /cancelled/);
  await assert.rejects(terminal.waitForHandback!(), /cancelled/);
  await assert.rejects(terminal.waitForHandback!(), /cancelled/);
});

test('Stop cancels a pending owned-terminal picker before any action runs', async (context) => {
  const abort = new AbortController();
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: abort.signal,
    approve: async () => true,
  });
  context.after(() => manager.dispose());
  context.mock.method(manager, 'choices', () => [
    {
      terminalId: 'fixture-only',
      label: 'OMP fixture-only',
      running: true,
      interactive: true,
      visible: true,
    },
  ]);
  let token!: vscode.CancellationToken;
  context.mock.method(
    window,
    'showQuickPick',
    (_items: unknown, _options: unknown, cancellation: vscode.CancellationToken) => {
      token = cancellation;
      return new Promise<undefined>((resolve) =>
        cancellation.onCancellationRequested(() => resolve(undefined)),
      );
    },
  );
  const picking = pickOwnedTerminal(manager, 'owner', () => {}, abort.signal);
  abort.abort(new Error('Stopped terminal picker'));
  await assert.rejects(picking, /Stopped terminal picker/);
  assert.equal(token.isCancellationRequested, true);
});

function pickerManager(context: TestContext) {
  const manager = new TerminalManager({
    sessionId: 'owner',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    approve: async () => true,
  });
  context.after(() => manager.dispose());
  const choice = {
    terminalId: 'exact-owned',
    label: 'OMP owned',
    running: true,
    interactive: true,
    visible: true,
  };
  context.mock.method(manager, 'choices', () => [
    { ...choice, terminalId: 'hidden', visible: false },
    choice,
  ]);
  return manager;
}

for (const operation of ['reveal', 'takeover', 'stop', 'cancel'] as const)
  test(`owned terminal picker dispatches only ${operation}`, async (context) => {
    const manager = pickerManager(context);
    const actions = {
      reveal: context.mock.method(manager, 'reveal', () => {}),
      takeover: context.mock.method(manager, 'takeover', async () => {}),
      stop: context.mock.method(manager, 'kill', async () => {}),
    };
    let picks = 0;
    context.mock.method(
      window,
      'showQuickPick',
      async (items: Parameters<typeof window.showQuickPick>[0]) =>
        ++picks === 1 ? items[0] : items.find((item) => item.value === operation),
    );
    let restored = 0;
    await pickOwnedTerminal(
      manager,
      'owner',
      () => {},
      undefined,
      () => restored++,
    );
    assert.equal(picks, 2);
    assert.equal(restored, Number(operation === 'cancel'));
    for (const [name, action] of Object.entries(actions)) {
      assert.equal(action.mock.callCount(), Number(name === operation));
      if (name === operation)
        assert.deepEqual(action.mock.calls[0]!.arguments[0], {
          sessionId: 'owner',
          terminalId: 'exact-owned',
        });
    }
  });

for (const stage of [1, 2])
  for (const stale of [false, true])
    test(`owned terminal picker stage ${stage} refuses cancelled/stale=${stale}`, async (context) => {
      const manager = pickerManager(context);
      const reveal = context.mock.method(manager, 'reveal', () => {});
      let picks = 0;
      let expired = false;
      context.mock.method(
        window,
        'showQuickPick',
        async (items: Parameters<typeof window.showQuickPick>[0]) => {
          if (++picks !== stage) return items[0];
          expired = stale;
          return undefined;
        },
      );
      let restored = 0;
      const picking = pickOwnedTerminal(
        manager,
        'owner',
        () => {
          if (expired) throw new Error('Expired picker scope');
        },
        undefined,
        () => restored++,
      );
      if (stale) await assert.rejects(picking, /Expired picker scope/);
      else await picking;
      assert.equal(picks, stage);
      assert.equal(reveal.mock.callCount(), 0);
      assert.equal(restored, Number(!stale));
    });
