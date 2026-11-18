import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;
type Request = (message: object) => Promise<void>;
interface Entry {
  type: string;
  summary?: string;
  tokensBefore?: number;
}
interface Message {
  role: string;
  toolCallId?: string;
  content?: { type: string; id?: string }[];
}

async function providerContext(): Promise<{ messages: Message[] }> {
  return JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'));
}

function toolPairs(messages: Message[]) {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant')
      for (const block of message.content ?? [])
        if (block.type === 'toolCall') calls.add(block.id!);
    if (message.role === 'toolResult') assert.ok(calls.has(message.toolCallId!));
  }
  return calls.size;
}

async function populate(api: Api, request: Request) {
  await request({ type: 'new' });
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ type: 'prompt', text: 'COMPACTION_SUMMARIZED_PAST HUNK_REVIEW_FIXTURE' });
  await request({ type: 'prompt', text: 'FUTURE_SENTINEL' });
  const repeated = `COMPACTION_PAST ${'preserved context '.repeat(3500)}`.trim();
  await request({ type: 'prompt', text: repeated });
  await request({ type: 'prompt', text: repeated });
  await request({ type: 'prompt', text: 'COMPACTION_RECENT' });
  assert.doesNotMatch(
    JSON.stringify((await providerContext()).messages),
    /SUMMARY_ONLY_FUTURE_SENTINEL/,
  );
  const identities = api
    .status()!
    .turns.filter((turn) => turn.prompt === repeated)
    .map((turn) => turn.history!.promptEntryId);
  assert.equal(identities.length, 2);
  assert.equal(new Set(identities).size, 2);
  const source = api.status()!.sessionId!;
  const second = api.status()!.turns.filter((turn) => turn.prompt === repeated)[1]!;
  await request({ type: 'forkTurn', id: second.id, boundary: 'before' });
  await request({ type: 'prompt', text: 'REPEATED_IDENTITY_BOUNDARY' });
  assert.equal(
    JSON.stringify((await providerContext()).messages).match(/COMPACTION_PAST/g)?.length,
    1,
  );
  await api.resume!(source);
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
}

async function compact(api: Api, request: Request) {
  const document = await vscode.workspace.openTextDocument({
    content: 'COMPACTION_PENDING_ATTACHMENT',
  });
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(0), 'dirty ');
  assert.ok(await vscode.workspace.applyEdit(edit));
  await request({ type: 'attach' });
  const pending = structuredClone(api.status()!.attachments);
  await request({ type: 'compact' });
  assert.equal(api.status()!.compacting, false);
  assert.equal(api.status()!.context?.stale, true);
  assert.deepEqual(api.status()!.attachments, pending);
  const branch = JSON.parse(
    await readFile(`${process.env.VS_OMP_FIXTURE_CONTEXT}.branch.json`, 'utf8'),
  ) as Entry[];
  const summary = branch.find((entry) => entry.type === 'compaction');
  assert.ok(summary, 'Populated /compact must persist an actual native compaction entry');
  assert.match(summary.summary!, /FIXTURE_REPLY.*SUMMARY_ONLY_FUTURE_SENTINEL/);
  assert.ok(summary.tokensBefore! > 20000);
  await request({ type: 'prompt', text: 'COMPACTION_CONTINUATION' });
  const messages = JSON.stringify((await providerContext()).messages);
  assert.match(messages, /FUTURE_SENTINEL/);
  assert.match(messages, /SUMMARY_ONLY_FUTURE_SENTINEL/);
  assert.match(messages, /COMPACTION_PENDING_ATTACHMENT/);
  assert.ok(api.status()!.context!.used > 0);
  assert.notEqual(api.status()!.context?.stale, true);
  assert.equal(api.status()!.attachments.length, 0);
  const cost = api.status()!.context?.cost;
  assert.ok(cost === undefined || cost.amount === 0);
  assert.equal(document.getText(), 'dirty COMPACTION_PENDING_ATTACHMENT');
  assert.equal(document.isDirty, true);
  console.log(
    'PASS: populated compaction persists a generated summary, preserves attachments and refreshes stale usage.',
  );
}

async function boundaries(api: Api, request: Request) {
  const source = api.status()!.sessionId!;
  const past = api.status()!.turns[0]!;
  const nativeId = past.history!.sessionId;
  await request({ type: 'forkTurn', id: past.id, boundary: 'after' });
  await request({ type: 'prompt', text: 'PRE_COMPACTION_FORK' });
  const before = (await providerContext()).messages;
  assert.doesNotMatch(JSON.stringify(before), /FUTURE_SENTINEL/);
  assert.ok(toolPairs(before) > 0);
  await api.resume!(source);
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  assert.equal(api.status()!.turns[0]!.history!.sessionId, nativeId);
  await request({ type: 'prompt', text: 'POST_COMPACTION_RECONNECT' });
  assert.match(JSON.stringify((await providerContext()).messages), /SUMMARY_ONLY_FUTURE_SENTINEL/);
  const continuation = api
    .status()!
    .turns.find((turn) => turn.prompt === 'COMPACTION_CONTINUATION')!;
  await request({ type: 'forkTurn', id: continuation.id, boundary: 'after' });
  await request({ type: 'prompt', text: 'POST_COMPACTION_FORK' });
  assert.match(JSON.stringify((await providerContext()).messages), /SUMMARY_ONLY_FUTURE_SENTINEL/);
  await request({ type: 'editPrompt', id: continuation.id, text: 'POST_COMPACTION_EDIT' });
  assert.match(JSON.stringify((await providerContext()).messages), /SUMMARY_ONLY_FUTURE_SENTINEL/);
  const future = api.status()!.turns.find((turn) => turn.prompt === 'FUTURE_SENTINEL')!;
  await request({ type: 'editPrompt', id: future.id, text: 'COMPACTION_REPLACEMENT' });
  assert.doesNotMatch(JSON.stringify((await providerContext()).messages), /FUTURE_SENTINEL/);
  toolPairs((await providerContext()).messages);
  const first = api.status()!.turns[0]!;
  await request({ type: 'forkTurn', id: first.id, boundary: 'before' });
  assert.equal(api.status()!.turns.length, 0);
  await request({ type: 'prompt', text: 'COMPACTION_ROOT_CONTINUATION' });
  assert.doesNotMatch(JSON.stringify((await providerContext()).messages), /FUTURE_SENTINEL/);
  console.log(
    'PASS: compaction edit/fork/root/reconnect boundaries exclude abandoned summaries and retain tool pairs.',
  );
}

async function nativeHookRefusal(api: Api, request: Request) {
  await request({ type: 'prompt', text: 'HISTORY_HOOK_REFUSAL_FIXTURE' });
  const source = api.status()!.sessionId!;
  const changes = structuredClone(api.storedState!().changes);
  const provider = await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8');
  for (const action of ['fork', 'edit']) {
    const selected = api.status()!.turns.at(-1)!;
    const command =
      action === 'fork'
        ? { type: 'forkTurn', id: selected.id, boundary: 'before' }
        : { type: 'editPrompt', id: selected.id, text: 'HOOK_REFUSED_REPLACEMENT' };
    await assert.rejects(request(command), /navigation was cancelled/);
    assert.equal(api.status()!.connected, false);
    await api.resume!(source);
    await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
    assert.equal(api.status()!.turns.at(-1)!.prompt, 'HISTORY_HOOK_REFUSAL_FIXTURE');
    assert.deepEqual(api.storedState!().changes, changes);
    assert.equal(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'), provider);
  }
  console.log(
    'PASS: native pre-tree hook refuses fork/edit after mixed file review without replay or ownership changes.',
  );
}

async function mutationHistory(api: Api, request: Request, root: vscode.Uri) {
  await request({ type: 'new' });
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  const created = vscode.Uri.joinPath(root, 'history-created.txt');
  await request({ type: 'prompt', text: 'HISTORY_CREATE_FIXTURE' });
  const creation = api.status()!.changes.find((change) => change.name === 'history-created.txt')!;
  await request({ type: 'keep', id: creation.id });
  await request({ type: 'prompt', text: 'HISTORY_EDIT_FIXTURE' });
  const changed = api.status()!.changes.find((change) => change.name === 'history-created.txt')!;
  await request({ type: 'discard', id: changed.id });
  assert.equal(await readFile(created.fsPath, 'utf8'), 'created\n');
  await request({ type: 'prompt', text: 'NATIVE_MUTATION_FIXTURE delete' });
  const deleted = vscode.Uri.joinPath(root, 'probe.txt');
  await assert.rejects(readFile(deleted.fsPath), { code: 'ENOENT' });
  const pending = structuredClone(api.storedState!().changes);
  const source = api.status()!.sessionId!;
  const past = api.status()!.turns[0]!;
  await writeFile(created.fsPath, 'newer external edit\n');
  await request({ type: 'forkTurn', id: past.id, boundary: 'after' });
  await request({ type: 'prompt', text: 'MUTATION_HISTORY_FORK' });
  assert.equal(api.status()!.changes.length, 0);
  await api.resume!(source);
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  const last = api.status()!.turns.at(-1)!;
  await request({ type: 'editPrompt', id: last.id, text: 'MUTATION_HISTORY_REPLACEMENT' });
  assert.equal(await readFile(created.fsPath, 'utf8'), 'newer external edit\n');
  await assert.rejects(readFile(deleted.fsPath), { code: 'ENOENT' });
  assert.deepEqual(api.storedState!().changes, pending);
  await nativeHookRefusal(api, request);
  assert.equal(await readFile(created.fsPath, 'utf8'), 'newer external edit\n');
  await assert.rejects(readFile(deleted.fsPath), { code: 'ENOENT' });
  console.log(
    'PASS: native history after Keep/Discard preserves new/deleted files, newer external edits and source-only review ownership.',
  );
}

function providerSignal(marker: string) {
  const file = process.env.VS_OMP_FIXTURE_CONTEXT!;
  const watcher = watch(file);
  let deadline!: ReturnType<typeof setTimeout>;
  const entered = new Promise<void>((resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error('Fixture provider did not enter interrupted turn')),
      10000,
    );
    watcher.on('error', reject);
    watcher.on('change', () => {
      void readFile(file, 'utf8').then((text) => {
        if (text.includes(marker)) resolve();
      }, reject);
    });
  });
  return {
    entered,
    dispose: () => {
      clearTimeout(deadline);
      watcher.close();
    },
  };
}

async function interruptedHistory(api: Api, request: Request) {
  const pending = structuredClone(api.storedState!().changes);
  const signal = providerSignal('HISTORY_INTERRUPT_FIXTURE');
  const running = request({ type: 'prompt', text: 'HISTORY_INTERRUPT_FIXTURE' });
  try {
    await signal.entered;
    await request({ type: 'cancel' });
    await running;
  } finally {
    signal.dispose();
  }
  const cancelled = api.status()!.turns.at(-1)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.history, 'Interrupted native user entries must retain a canonical boundary');
  await assert.rejects(
    request({ type: 'forkTurn', id: cancelled.id, boundary: 'after' }),
    /completed turn/,
  );
  await request({ type: 'forkTurn', id: cancelled.id, boundary: 'before' });
  await request({ type: 'prompt', text: 'INTERRUPTED_PREFIX_CONTINUATION' });
  assert.doesNotMatch(
    JSON.stringify((await providerContext()).messages),
    /HISTORY_INTERRUPT_FIXTURE/,
  );
  assert.deepEqual(api.storedState!().changes, pending);
  console.log(
    'PASS: interrupted native turns retain before-prompt boundaries, refuse after-answer forks and never replay cancelled work.',
  );
}

async function failedCompaction(api: Api, request: Request, outcome: 'FAILURE' | 'CANCEL') {
  await request({ type: 'new' });
  await request({ type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await request({ type: 'prompt', text: `COMPACTION_${outcome}_FIXTURE` });
  const large = `COMPACTION_FAULT_PAST ${'preserved context '.repeat(3500)}`.trim();
  await request({ type: 'prompt', text: large });
  await request({ type: 'prompt', text: large });
  await request({ type: 'prompt', text: 'COMPACTION_FAULT_RECENT' });
  const document = await vscode.workspace.openTextDocument({ content: 'FAULT_PENDING_CONTEXT' });
  await vscode.window.showTextDocument(document);
  await request({ type: 'attach' });
  const pending = structuredClone(api.status()!.attachments);
  const changes = structuredClone(api.storedState!().changes);
  const branchFile = `${process.env.VS_OMP_FIXTURE_CONTEXT}.branch.json`;
  const branch = await readFile(branchFile, 'utf8');
  const signal = outcome === 'CANCEL' ? providerSignal('COMPACTION_CANCEL_FIXTURE') : undefined;
  let failure = '';
  const compacting = request({ type: 'compact' }).catch((error: unknown) => {
    failure = String(error);
  });
  try {
    if (signal) {
      await signal.entered;
      assert.equal(api.status()!.compacting, true);
      assert.equal(api.status()!.turns.at(-1)!.prompt, '/compact');
      assert.equal(api.status()!.turns.at(-1)!.status, 'running');
      await request({ type: 'cancel' });
    }
    await compacting;
  } finally {
    signal?.dispose();
  }
  assert.equal(api.status()!.compacting, false);
  assert.equal(api.status()!.busy, false);
  assert.equal(api.status()!.context?.stale, true);
  assert.deepEqual(api.status()!.attachments, pending);
  assert.deepEqual(api.storedState!().changes, changes);
  assert.equal(
    await readFile(branchFile, 'utf8'),
    branch,
    'Failed compaction must not emit a persisted-success event',
  );
  if (outcome === 'FAILURE')
    assert.match(
      failure +
        api
          .status()!
          .turns.at(-1)!
          .blocks.map((block) => block.text)
          .join('\n'),
      /Fixture summarizer refused|compaction failed/i,
    );
  else assert.equal(api.status()!.turns.at(-1)!.status, 'cancelled');
  assert.equal(document.getText(), 'FAULT_PENDING_CONTEXT');
  console.log(
    `PASS: native populated compaction ${outcome.toLowerCase()} preserves pending context and never records success.`,
  );
}

export async function nativeCompaction(api: Api, root: vscode.Uri): Promise<void> {
  const request: Request = (message) => api.request!({ v: 1, ...message });
  await populate(api, request);
  const changes = structuredClone(api.storedState!().changes);
  const file = vscode.Uri.joinPath(root, 'chat-hunks.txt');
  const text = await readFile(file.fsPath, 'utf8');
  await compact(api, request);
  await boundaries(api, request);
  assert.deepEqual(api.storedState!().changes, changes);
  assert.equal(await readFile(file.fsPath, 'utf8'), text);
  console.log(
    'PASS: compaction and history navigation preserve workspace text and pending review ownership.',
  );
  await mutationHistory(api, request, root);
  await interruptedHistory(api, request);
  await failedCompaction(api, request, 'FAILURE');
  await failedCompaction(api, request, 'CANCEL');
}
