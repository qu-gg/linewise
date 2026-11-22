import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { executeWorkspaceTask } from '../host-tasks.js';
import { TerminalManager } from '../terminal.js';
import { taskRequest } from '../task-policy.js';

const definitions = [
  ['Native task pass', 'process.stdout.write("NATIVE_TASK_PASS\\n");'],
  [
    'Native task fail',
    'const row={path:"task-failure.ts",line:2,column:3,message:"expected 14 received 21\\nmultiline detail"};for(const entry of [row,{...row,path:".task-private/hidden.ts"},{...row,path:"/tmp/outside-task.ts"},{...row,line:999}])process.stderr.write(JSON.stringify(entry)+"\\n");process.exitCode=3;',
  ],
  ['Native task cancel', 'require("node:fs").writeFileSync("native-task-late.txt","bad");'],
  ['Native graph first', 'require("node:fs").writeFileSync("native-graph-first.txt","first");'],
  ['Native graph second', 'require("node:fs").writeFileSync("native-graph-second.txt","second");'],
  [
    'Native graph final',
    'const files=require("node:fs");process.stdout.write(files.readFileSync("native-graph-first.txt","utf8")+files.readFileSync("native-graph-second.txt","utf8"));',
  ],
  [
    'Native readiness watch',
    'require("node:fs").writeFileSync("native-watch-pid.txt",String(process.pid));process.stdout.write("NATIVE_READY\\n");setInterval(()=>{},1000);',
  ],
  [
    'Native readiness final',
    'process.kill(Number(require("node:fs").readFileSync("native-watch-pid.txt","utf8")),0);process.stdout.write("DEPENDENT_AFTER_READY");',
  ],
  [
    'Native failure watch',
    'const files=require("node:fs");files.writeFileSync("native-failure-pid.txt",String(process.pid));files.watch(".",(_event,name)=>{if(name==="native-trigger-failure.txt")process.exit(7);});process.stdout.write("NATIVE_READY\\n");',
  ],
  [
    'Native failure final',
    'require("node:fs").writeFileSync("native-trigger-failure.txt","fail");setInterval(()=>{},1000);',
  ],
  [
    'Native Stop final',
    'const fs=require("node:fs");fs.writeFileSync("native-stop-pid.tmp",String(process.pid));fs.renameSync("native-stop-pid.tmp","native-stop-pid.txt");setInterval(()=>{},1000);',
  ],
];

export async function nativeOwnedTasks(root: vscode.Uri): Promise<void> {
  const source = 'parity-owned-task-fixture';
  const provider = vscode.tasks.registerTaskProvider(source, {
    provideTasks: () =>
      definitions.map(([name, command]) => {
        const task = new vscode.Task(
          { type: source, name },
          vscode.workspace.workspaceFolders![0]!,
          name!,
          source,
          new vscode.ProcessExecution(process.execPath, ['-e', command!], {
            cwd: root.fsPath,
            env: { ELECTRON_RUN_AS_NODE: '1' },
          }),
        );
        task.isBackground = name!.endsWith(' watch');
        return task;
      }),
    resolveTask: () => undefined,
  });
  const scope = {
    sessionId: 'native-tasks',
    cwd: root.fsPath,
    privateRoot: path.join(root.fsPath, '.task-private'),
    signal: AbortSignal.timeout(20000),
    valid: () => true,
  };
  let approvals = 0;
  const manager = new TerminalManager({
    ...scope,
    approve: async (command) => {
      approvals++;
      assert.equal(command.command, process.execPath);
      assert.equal(command.cwd, root.fsPath);
      assert.deepEqual(command.env, { ELECTRON_RUN_AS_NODE: '1' });
      return true;
    },
  });
  try {
    const dirty = await nativeTaskDirtyGuard(root, scope, source, manager);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, 'task-failure.ts'),
      Buffer.from('first\n  failed\n'),
    );
    for (const [name, code] of [
      ['Native task pass', 0],
      ['Native task fail', 3],
    ] as const) {
      const result = JSON.parse(
        await executeWorkspaceTask(taskRequest.parse({ name, source }), scope, manager),
      );
      assert.equal(result.exitStatus.exitCode, code);
      assert.equal(result.untrusted, true);
      assert.match(result.output, code ? /expected 14 received 21/ : /NATIVE_TASK_PASS/);
      if (code) await nativeTaskDiagnostics(root, result.diagnostics);
    }
    assert.equal(approvals, 2);
    await nativeTaskGraphs(scope, source, manager);
    await nativeTaskReadiness(scope, source, manager);
    await nativeTaskGraphStop(scope, source);
    await nativeTaskCancellation(scope, source);
    assert.equal(dirty.document.isDirty, true);
    assert.equal(dirty.document.getText(), 'UNSAVED_NATIVE_TASK_BASELINE\n');
    assert.equal(await readFile(dirty.uri.fsPath, 'utf8'), 'NATIVE_TASK_BASELINE\n');
    console.log(
      'PASS: native Tasks UI runs approved concrete snapshots, reports failed exits and cancels pending approval without late execution.',
    );
  } finally {
    provider.dispose();
    await manager.dispose();
  }
}

async function nativeTaskDiagnostics(
  root: vscode.Uri,
  result: { items: Array<{ path: string; line: number; column: number }>; ignored: number },
) {
  assert.equal(result.items.length, 1);
  assert.equal(result.ignored, 3);
  assert.deepEqual(
    result.items.map((row) => [row.path, row.line, row.column]),
    [['task-failure.ts', 2, 3]],
  );
  const uri = vscode.Uri.joinPath(root, 'task-failure.ts');
  const diagnostics = vscode.languages
    .getDiagnostics(uri)
    .filter((entry) => entry.source === 'OMP Task');
  assert.equal(diagnostics.length, 1);
  const editor = await vscode.window.showTextDocument(uri, { selection: diagnostics[0]!.range });
  assert.equal(editor.document.uri.toString(), uri.toString());
  assert.equal(editor.selection.start.line, 1);
  assert.equal(editor.selection.start.character, 2);
  console.log(
    'PASS: native task Problems contain only the exact in-root failure and public navigation opens its current file/line/column.',
  );
}

async function nativeTaskReadiness(
  scope: Parameters<typeof executeWorkspaceTask>[1],
  source: string,
  manager: TerminalManager,
) {
  for (const [kind, expected] of [
    ['readiness', 'passed'],
    ['failure', 'failed'],
  ] as const) {
    const name = `Native ${kind} final`;
    const result = JSON.parse(
      await executeWorkspaceTask(
        taskRequest.parse({
          name,
          source,
          graph: [
            {
              id: 'watch',
              name: `Native ${kind} watch`,
              source,
              dependsOn: [],
              readiness: { line: 'NATIVE_READY' },
            },
            { id: 'final', name, source, dependsOn: ['watch'] },
          ],
        }),
        scope,
        manager,
      ),
    );
    assert.equal(result.status, expected);
    assert.equal(result.results[0].readiness, 'ready');
    if (kind === 'readiness') {
      assert.equal(result.results[0].cleanup, 'graph-complete');
      assert.equal(result.results[1].output, 'DEPENDENT_AFTER_READY');
    } else {
      assert.equal(result.results[0].exitStatus.exitCode, 7);
      assert.equal(result.results[1].status, 'cancelled');
    }
    const file = kind === 'readiness' ? 'native-watch-pid.txt' : 'native-failure-pid.txt';
    const pid = Number(await readFile(path.join(scope.cwd, file), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(manager.choices().length, 0);
  }
  console.log(
    'PASS: native background graph readiness precedes dependent execution, premature failure cancels it, and all workers are cleaned.',
  );
}

async function nativeTaskGraphStop(
  scope: Parameters<typeof executeWorkspaceTask>[1],
  source: string,
) {
  const abort = new AbortController();
  const owned = { ...scope, signal: AbortSignal.any([scope.signal, abort.signal]) };
  const manager = new TerminalManager({ ...owned, approve: async () => true });
  let launched!: () => void;
  const started = new Promise<void>((resolve) => {
    launched = resolve;
  });
  const watcher = watch(scope.cwd, (_event, name) => {
    if (name === 'native-stop-pid.txt') launched();
  });
  try {
    const running = executeWorkspaceTask(
      taskRequest.parse({
        name: 'Native Stop final',
        source,
        graph: [
          {
            id: 'watch',
            name: 'Native readiness watch',
            source,
            dependsOn: [],
            readiness: { line: 'NATIVE_READY' },
          },
          { id: 'final', name: 'Native Stop final', source, dependsOn: ['watch'] },
        ],
      }),
      owned,
      manager,
    );
    const rejected = assert.rejects(running, /Native graph Stop/);
    await started;
    abort.abort(new Error('Native graph Stop'));
    await rejected;
    for (const file of ['native-watch-pid.txt', 'native-stop-pid.txt']) {
      const pid = Number(await readFile(path.join(scope.cwd, file), 'utf8'));
      assert.ok(pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    console.log(
      'PASS: native Stop during a readiness-gated graph waits for both prerequisite and dependent process cleanup.',
    );
  } finally {
    watcher.close();
    await manager.dispose();
  }
}

async function nativeTaskGraphs(
  scope: Parameters<typeof executeWorkspaceTask>[1],
  source: string,
  manager: TerminalManager,
) {
  const node = (id: string, name: string, dependsOn: string[] = []) => ({
    id,
    name,
    source,
    dependsOn,
  });
  const starts: string[] = [];
  const events = vscode.tasks.onDidStartTask((event) => {
    if (event.execution.task.source === 'OMP') starts.push(event.execution.task.name);
  });
  const run = async (graph: Array<ReturnType<typeof node>>) =>
    JSON.parse(
      await executeWorkspaceTask(
        taskRequest.parse({ name: 'Native graph final', source, graph }),
        scope,
        manager,
      ),
    );
  try {
    const passed = await run([
      node('first', 'Native graph first'),
      node('second', 'Native graph second'),
      node('final', 'Native graph final', ['first', 'second']),
    ]);
    assert.equal(passed.graph, 'OMP-owned');
    assert.equal(passed.status, 'passed');
    assert.equal(passed.results[2].output, 'firstsecond');
    assert.deepEqual([...starts].sort(), [
      'Native graph final',
      'Native graph first',
      'Native graph second',
    ]);
    starts.length = 0;
    const failed = await run([
      node('failed', 'Native task fail'),
      node('final', 'Native graph final', ['failed']),
    ]);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.results[0].exitStatus.exitCode, 3);
    assert.equal(failed.results[1].status, 'not-started');
    assert.deepEqual(starts, ['Native task fail']);
    console.log(
      'PASS: native OMP-owned parallel task graph uses exact executions and failed prerequisites never launch dependents.',
    );
  } finally {
    events.dispose();
  }
}

async function nativeTaskDirtyGuard(
  root: vscode.Uri,
  scope: Parameters<typeof executeWorkspaceTask>[1],
  source: string,
  manager: TerminalManager,
) {
  const uri = vscode.Uri.joinPath(root, 'native-task-dirty.md');
  await vscode.workspace.fs.writeFile(uri, Buffer.from('NATIVE_TASK_BASELINE\n'));
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, document.positionAt(0), 'UNSAVED_');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const config = vscode.workspace.getConfiguration('task', root);
  const previous = config.inspect<string>('saveBeforeRun')?.workspaceValue;
  try {
    await config.update('saveBeforeRun', 'always', vscode.ConfigurationTarget.Workspace);
    await assert.rejects(
      executeWorkspaceTask(taskRequest.parse({ name: 'Native task pass', source }), scope, manager),
      /could save dirty/,
    );
    assert.equal(document.isDirty, true);
    assert.equal(await readFile(uri.fsPath, 'utf8'), 'NATIVE_TASK_BASELINE\n');
  } finally {
    await config.update('saveBeforeRun', previous, vscode.ConfigurationTarget.Workspace);
  }
  assert.equal(
    config.get('saveBeforeRun'),
    'never',
    'The disposable fixture must explicitly disable native task autosave.',
  );
  return { document, uri };
}

async function nativeTaskCancellation(
  scope: Parameters<typeof executeWorkspaceTask>[1],
  source: string,
): Promise<void> {
  let shown!: () => void;
  let allow!: (value: boolean) => void;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const manager = new TerminalManager({
    ...scope,
    approve: async () => {
      shown();
      return new Promise<boolean>((resolve) => {
        allow = resolve;
      });
    },
  });
  try {
    const running = executeWorkspaceTask(
      taskRequest.parse({ name: 'Native task cancel', source }),
      scope,
      manager,
    );
    const rejected = assert.rejects(running, /cancelled/);
    await visible;
    const execution = vscode.tasks.taskExecutions.find(
      (entry) => entry.task.source === 'OMP' && entry.task.name === 'Native task cancel',
    );
    assert.ok(execution, 'Real native task execution must be discoverable');
    execution.terminate();
    await rejected;
    allow(true);
    await assert.rejects(readFile(path.join(scope.cwd, 'native-task-late.txt')), {
      code: 'ENOENT',
    });
  } finally {
    await manager.dispose();
  }
}
