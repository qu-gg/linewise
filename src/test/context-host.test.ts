import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { Document, fixture, Position, Range, seedFile, Uri } from './vscode-fixture.js';
import { setup } from './extension-setup.js';
import { transport } from './acp-fixture.js';
import { imageContextSnapshot } from '../context.js';

test('active-editor offers expose identity only and reject stale, dismissed, foreign and already attached targets', async () => {
  const { ContextAttachments, contextSnapshot } = await import('../context.js');
  const attachments = new ContextAttachments();
  const resource = { uri: 'file:///workspace/first.txt', label: 'first.txt' };
  assert.equal(attachments.offer('first'), undefined);
  const first = attachments.offer('first', resource)!;
  assert.deepEqual(attachments.offer('first', resource), first);
  assert.deepEqual(Object.keys(first).sort(), ['id', 'label', 'uri']);
  assert.equal(attachments.offeredUri('first', first.id), resource.uri);
  assert.throws(() => attachments.offeredUri('foreign', first.id), /stale/);
  const second = attachments.offer('second', resource)!;
  assert.notEqual(first.id, second.id);
  assert.throws(() => attachments.dismissOffer('first', first.id), /stale/);
  attachments.dismissOffer('second', second.id);
  assert.equal(attachments.offer('second', resource), undefined);
  const other = attachments.offer('second', {
    uri: 'file:///workspace/other.txt',
    label: 'other.txt',
  })!;
  assert.notEqual(other.id, second.id);
  attachments.clear('second');
  assert.throws(() => attachments.offeredUri('second', other.id), /stale/);
  assert.ok(attachments.offer('second', resource));
  attachments.add('second', [contextSnapshot('file', resource.label, resource.uri, 'captured')]);
  assert.equal(attachments.offer('second', resource), undefined);
});

test('test-only staging validates images through the current idle context owner', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  const image = imageContextSnapshot(
    'staged.png',
    Uri.file(path.join(host.root, 'staged.png')).toString(),
    { mimeType: 'image/png', data },
  );
  await host.attachSnapshots!([image]);
  assert.equal(host.status()!.attachments[0]!.kind, 'image');
  await assert.rejects(
    host.attachSnapshots!([{ ...image, image: { mimeType: 'image/png', data: 'invalid' } }]),
  );
  assert.equal(host.status()!.attachments.length, 1);
});

test('new-chat context only transfers to the initial fresh owner, never a resumed or switched session', async () => {
  const { ContextAttachments, contextSnapshot } = await import('../context.js');
  const attachments = new ContextAttachments();
  attachments.add('new', [
    contextSnapshot('file', 'file.txt', 'file:///workspace/file.txt', 'draft'),
  ]);
  attachments.bindSession('resumed', undefined, true);
  attachments.bindSession('switched', 'previous');
  assert.equal(attachments.list('new').length, 1);
  assert.deepEqual(attachments.list('resumed'), []);
  assert.deepEqual(attachments.list('switched'), []);
  attachments.bindSession('fresh');
  assert.equal(attachments.list('fresh')[0]!.text, 'draft');
  assert.deepEqual(attachments.list('new'), []);
});

test('active-editor offer and clicked-file command capture whole unsaved snapshots without submission', async (context) => {
  const host = await setup(context);
  const first = Uri.file(path.join(host.root, 'first.txt'));
  const second = Uri.file(path.join(host.root, 'second.txt'));
  seedFile(first.fsPath, 'disk first');
  seedFile(second.fsPath, 'disk second');
  const dirty = new Document(first, 'whole unsaved text');
  fixture.documents.push(dirty);
  fixture.editor = {
    document: dirty,
    selection: { isEmpty: false, start: new Position(0, 0), end: new Position(0, 5) },
  };
  const offer = host.status()!.contextOffer!;
  assert.equal(offer.label, 'first.txt');
  assert.deepEqual(host.status()!.attachments, []);
  await host.request({ type: 'attachOffer', id: offer.id });
  assert.equal(host.status()!.attachments.length, 1);
  assert.equal(host.storedState!().sessions.length, 0);
  assert.equal(host.status()!.contextOffer, undefined);
  assert.equal(host.status()!.connected, false);
  await assert.rejects(host.request({ type: 'attachOffer', id: offer.id }), /stale/);
  dirty.text = 'later text';
  await fixture.commands.get('omp.addFileContext')!(second);
  assert.deepEqual(
    host.status()!.attachments.map((item) => item.uri),
    [first.toString(), second.toString()],
  );
  await host.request({ type: 'connect' });
  transport.onPrompt = async (blocks) => {
    assert.match(JSON.stringify(blocks), /whole unsaved text/);
    assert.doesNotMatch(JSON.stringify(blocks), /later text/);
  };
  await host.request({ type: 'prompt', text: 'Explicit submission' });
});

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

test('active file offers dismiss without attaching, update on editor changes and respect opt-out', async (context) => {
  const host = await setup(context);
  const uri = Uri.file(path.join(host.root, 'active.txt'));
  const document = new Document(uri, 'not attached');
  fixture.editor = { document, selection: { isEmpty: true } };
  const first = host.status()!.contextOffer!;
  await host.request({ type: 'dismissOffer', id: first.id });
  assert.equal(host.status()!.contextOffer, undefined);
  assert.deepEqual(host.status()!.attachments, []);
  fixture.editor = {
    document: new Document(Uri.file(path.join(host.root, 'other.txt')), ''),
    selection: { isEmpty: true },
  };
  for (const listener of fixture.editorListeners) listener();
  const second = host.status()!.contextOffer!;
  assert.notEqual(second.id, first.id);
  fixture.editor = { document, selection: { isEmpty: true } };
  await assert.rejects(host.request({ type: 'attachOffer', id: second.id }), /stale/);
  fixture.configuration.set('omp.context.activeEditorOffer', false);
  assert.equal(host.status()!.contextOffer, undefined);
  fixture.editor = undefined;
  await fixture.commands.get('omp.addFileContext')!();
  assert.match(host.status()!.error!, /Choose a file/);
  assert.deepEqual(host.status()!.attachments, []);
});

test('active-editor offers use the same host eligibility as explicit resource capture without side effects', async (context) => {
  const host = await setup(context);
  for (const resource of [
    'vscode-remote://foreign/private.txt',
    'file://foreign/private.txt',
    'git:/private.txt',
  ]) {
    fixture.editor = {
      document: new Document(Uri.parse(resource), 'not captured'),
      selection: { isEmpty: true },
    };
    assert.equal(host.status()!.contextOffer, undefined);
  }
  for (const uri of [
    Uri.file(path.join(host.root, 'active.txt')),
    Uri.parse('untitled:Untitled-1'),
  ]) {
    fixture.editor = { document: new Document(uri, 'not captured'), selection: { isEmpty: true } };
    assert.equal(host.status()!.contextOffer!.uri, uri.toString());
  }
  assert.deepEqual(host.status()!.attachments, []);
  assert.equal(host.status()!.connected, false);
  assert.equal(host.storedState!().sessions.length, 0);
});

test('explicit image selection sends captured pixels after source deletion and removal excludes unselected snapshots', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const first = path.join(host.root, 'captured.png');
  const second = path.join(host.root, 'removed.png');
  seedFile(first, bytes);
  seedFile(second, bytes);
  fixture.quickPick = 'images';
  fixture.openFiles = [Uri.file(first), Uri.file(second)];
  await host.request({ type: 'attachContext' });
  assert.equal(host.status()!.attachments.length, 2);
  const selected = host.status()!.attachments[0]!;
  assert.equal(selected.kind, 'image');
  assert.ok(!JSON.stringify(host.status()!.attachments).includes(bytes.toString('base64')));
  await host.request({ type: 'removeAttachment', id: host.status()!.attachments[1]!.id });
  fixture.disk.delete(first);
  fixture.disk.delete(second);
  await host.request({ type: 'inspectAttachment', id: selected.id });
  const opened = fixture.commandCalls.find((entry) => entry.id === 'vscode.open')!;
  assert.equal((opened.args[0] as Uri).scheme, 'omp-image');
  transport.onPrompt = async (blocks) => {
    assert.equal(blocks.length, 3);
    assert.equal(blocks[2]!.type, 'image');
    assert.equal((blocks[2] as { data: string }).data, bytes.toString('base64'));
    assert.doesNotMatch(JSON.stringify(blocks), /removed.png/);
  };
  await host.request({ type: 'prompt', text: 'Inspect the selected original image' });
  const saved = host.storedState!().sessions[0]!.turns[0]!.attachments![0]!;
  assert.equal(saved.image!.data, bytes.toString('base64'));
  assert.deepEqual(host.status()!.attachments, []);
});

test('image picker cancellation, host mismatch, invalid signatures and file limits preserve prior context', async (context) => {
  const host = await setup(context);
  fixture.quickPick = 'images';
  fixture.openFiles = [];
  await host.request({ type: 'attachContext' });
  assert.deepEqual(host.status()!.attachments, []);
  fixture.openFiles = [Uri.parse('vscode-remote://foreign/private.png')];
  await assert.rejects(host.request({ type: 'attachContext' }), /workspace host/);
  for (const [file, bytes] of [
    ['invalid.png', 'not PNG'],
    ['wrong.gif', 'GIF89a'],
  ] as const) {
    const target = path.join(host.root, file);
    seedFile(target, bytes);
    fixture.openFiles = [Uri.file(target)];
    await assert.rejects(host.request({ type: 'attachContext' }));
  }
  const target = path.join(host.root, 'large.png');
  seedFile(target, Buffer.alloc(524_289));
  fixture.openFiles = [Uri.file(target)];
  await assert.rejects(host.request({ type: 'attachContext' }), /512 KiB/);
  fixture.openFiles = Array.from({ length: 9 }, (_, index) =>
    Uri.file(path.join(host.root, `missing-${index}.png`)),
  );
  await assert.rejects(host.request({ type: 'attachContext' }), /at most eight/);
  const valid = Buffer.alloc(524_288);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(valid);
  fixture.openFiles = Array.from({ length: 3 }, (_, index) => {
    const uri = Uri.file(path.join(host.root, `aggregate-${index}.png`));
    seedFile(uri.fsPath, valid);
    return uri;
  });
  await assert.rejects(host.request({ type: 'attachContext' }), /at most 1 MiB/);
  assert.deepEqual(host.status()!.attachments, []);
});

test('image preview filesystem copies immutable bytes, denies all mutations and bounds retained inspection handles', async (context) => {
  await setup(context);
  const { ImageSnapshots } = await import('../host-image-context.js');
  const snapshots = new ImageSnapshots();
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = { mimeType: 'image/png' as const, data: data.toString('base64') };
  const uri = snapshots.capture(image);
  assert.equal(snapshots.stat(uri as any).size, data.byteLength);
  const copy = snapshots.readFile(uri as any);
  copy.fill(0);
  assert.deepEqual(Buffer.from(snapshots.readFile(uri as any)), data);
  snapshots.watch().dispose();
  for (const mutate of [
    () => snapshots.writeFile(),
    () => snapshots.delete(),
    () => snapshots.rename(),
    () => snapshots.createDirectory(),
    () => snapshots.readDirectory(),
  ])
    assert.throws(mutate, /NoPermissions/);
  for (let index = 0; index < 8; index++) snapshots.capture(image);
  assert.throws(() => snapshots.readFile(uri as any), /FileNotFound/);
  const large = Buffer.alloc(524_288);
  data.copy(large);
  const largeImage = { ...image, data: large.toString('base64') };
  const oldest = snapshots.capture(largeImage);
  snapshots.capture(largeImage);
  const newest = snapshots.capture(largeImage);
  assert.throws(() => snapshots.readFile(oldest as any), /FileNotFound/);
  assert.equal(snapshots.readFile(newest as any).byteLength, large.byteLength);
  snapshots.dispose();
  assert.throws(() => snapshots.readFile(newest as any), /FileNotFound/);
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

test('pasted clipboard images become immutable untitled image attachments and reach ACP as pixels', async (context) => {
  const host = await setup(context);
  await host.request({ type: 'connect' });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const data = bytes.toString('base64');
  await host.request({
    type: 'pasteImages',
    images: [{ mimeType: 'image/png', data }],
  });
  const [pending] = host.status()!.attachments;
  assert.equal(pending!.kind, 'image');
  assert.equal(pending!.label, 'Pasted PNG image');
  assert.match(pending!.uri, /^untitled:pasted-image-[\w-]+\.png$/);
  assert.ok(!JSON.stringify(host.status()!.attachments).includes(data));
  transport.onPrompt = async (blocks) => {
    assert.equal(blocks.length, 3);
    assert.equal(blocks[2]!.type, 'image');
    assert.equal((blocks[2] as { data: string }).data, data);
  };
  await host.request({ type: 'prompt', text: 'Describe the pasted image' });
  assert.equal(host.storedState!().sessions[0]!.turns[0]!.attachments![0]!.image!.data, data);
  assert.deepEqual(host.status()!.attachments, []);
});

test('pasted image batches reject malformed, oversized, excessive and over-budget payloads without losing context', async (context) => {
  const host = await setup(context);
  const valid = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const data = valid.toString('base64');
  await host.request({
    type: 'pasteImages',
    images: [{ mimeType: 'image/png', data }],
  });
  await assert.rejects(
    host.request({
      type: 'pasteImages',
      images: [{ mimeType: 'image/gif', data }],
    }),
    /Invalid sidebar message/,
  );
  await assert.rejects(
    host.request({
      type: 'pasteImages',
      images: [{ mimeType: 'image/png', data: 'not-base64' }],
    }),
    /Invalid sidebar message/,
  );
  await assert.rejects(
    host.request({
      type: 'pasteImages',
      images: [{ mimeType: 'image/png', data: Buffer.alloc(524_289).toString('base64') }],
    }),
    /Invalid sidebar message/,
  );
  await assert.rejects(
    host.request({
      type: 'pasteImages',
      images: Array.from({ length: 9 }, () => ({ mimeType: 'image/png', data })),
    }),
    /Invalid sidebar message/,
  );
  const full = Buffer.alloc(524_288);
  valid.copy(full);
  await assert.rejects(
    host.request({
      type: 'pasteImages',
      images: Array.from({ length: 3 }, () => ({
        mimeType: 'image/png',
        data: full.toString('base64'),
      })),
    }),
    /1 MiB/,
  );
  assert.equal(host.status()!.attachments.length, 1);
  assert.equal(host.status()!.attachments[0]!.id, host.status()!.attachments[0]!.id);
});
