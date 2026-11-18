import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { Document, fixture, Position, Range, seedFile, Uri } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';

test('context picker cancellation and invalid or missing resources never attach data', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'attachContext' });
  assert.deepEqual(host.status()!.attachments, []);
  fixture.quickPick = 'files';
  fixture.openFiles = [Uri.parse('vscode-remote://foreign/private.txt')];
  await assert.rejects(host.request({ type: 'attachContext' }), /workspace host/);
  fixture.openFiles = [Uri.file(path.join(host.root, 'missing.txt'))];
  await assert.rejects(host.request({ type: 'attachContext' }), /no longer exists/);
  assert.deepEqual(host.status()!.attachments, []);
});

test('explicit multi-file snapshots can be inspected and removed and never reread later editor content', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const first = path.join(host.root, 'first.txt');
  const second = path.join(host.root, 'second.txt');
  seedFile(first, 'disk');
  seedFile(second, 'second');
  const dirty = new Document(Uri.file(first), 'captured dirty text');
  fixture.documents.push(dirty);
  fixture.quickPick = 'files';
  fixture.openFiles = [Uri.file(first), Uri.file(second)];
  await host.request({ type: 'attachContext' });
  assert.equal(host.status()!.attachments.length, 2);
  const snapshot = host.status()!.attachments[0]!;
  await host.request({ type: 'inspectAttachment', id: snapshot.id });
  assert.equal(fixture.documents.at(-1)!.text, 'captured dirty text');
  await host.request({ type: 'removeAttachment', id: host.status()!.attachments[1]!.id });
  await assert.rejects(host.request({ type: 'inspectAttachment', id: 'foreign' }), /session/);
  dirty.text = 'later unsaved content';
  transport.onPrompt = async (blocks) => {
    assert.equal(blocks.length, 2);
    assert.match(JSON.stringify(blocks[1]), /captured dirty text/);
    assert.doesNotMatch(JSON.stringify(blocks), /later unsaved content/);
  };
  await host.request({ type: 'prompt', text: 'Use only selected context' });
  assert.deepEqual(host.status()!.attachments, []);
  assert.equal(host.storedState!().sessions[0]!.turns[0]!.attachments!.length, 1);
});

test('explicit resources and diagnostics exclude unrelated documents and out-of-workspace problems', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const chosen = new Document(Uri.parse('untitled:///chosen.txt'), 'explicit resource');
  fixture.documents.push(
    chosen,
    new Document(Uri.parse('untitled:///unrelated.txt'), 'private unrelated text'),
    new Document(Uri.file(path.join(host.root, 'unselected.txt')), 'unselected file context'),
  );
  fixture.quickPick = 'resources';
  fixture.resourcePicks = ['chosen.txt'];
  await host.request({ type: 'attachContext' });
  fixture.diagnostics = [
    [
      Uri.file(path.join(host.root, 'code.ts')),
      [
        {
          message: 'Chosen diagnostic',
          severity: 0,
          range: new Range(new Position(1, 2), new Position(1, 3)),
        },
      ],
    ],
    [
      Uri.file('/outside/private.ts'),
      [
        {
          message: 'Unrelated diagnostic',
          severity: 1,
          range: new Range(new Position(0, 0), new Position(0, 1)),
        },
      ],
    ],
  ];
  fixture.quickPick = 'diagnostics';
  await host.request({ type: 'attachContext' });
  transport.onPrompt = async (blocks) => {
    assert.equal(blocks.length, 3);
    assert.match(JSON.stringify(blocks), /Chosen diagnostic/);
    assert.doesNotMatch(
      JSON.stringify(blocks),
      /Unrelated diagnostic|private unrelated text|unselected file context/,
    );
  };
  await host.request({ type: 'prompt', text: 'Inspect the selected context' });
});

test('editor range capture excludes unselected text and attachment drafts stay with their session', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  fixture.editor = {
    document: new Document(
      Uri.file(path.join(host.root, 'selection.txt')),
      'private prefix\nselected\nprivate suffix',
    ),
    selection: { isEmpty: false, start: new Position(1, 0), end: new Position(1, 8) },
  };
  fixture.quickPick = 'editor';
  await host.request({ type: 'attachContext' });
  transport.onPrompt = async (blocks) => {
    assert.match(JSON.stringify(blocks), /selected/);
    assert.doesNotMatch(JSON.stringify(blocks), /private prefix|private suffix/);
  };
  await host.request({ type: 'prompt', text: 'Read my selection' });
  await host.request({ type: 'attach' });
  transport.nextSessionId = 'new-context-session';
  await host.request({ type: 'new' });
  assert.deepEqual(host.status()!.attachments, []);
});
