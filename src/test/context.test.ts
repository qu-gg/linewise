import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextAttachments, contextSnapshot, imageContextSnapshot } from '../context.js';
import { imagePayload, decodeImage, imageSchema } from '../image-policy.js';
import { promptBlocks } from '../acp.js';

test('explicit context is bounded, immutable, session-scoped and removable only by its opaque identity', () => {
  const context = new ContextAttachments();
  const first = contextSnapshot('selection', 'file.txt:1', 'file:///file.txt', 'unsaved text');
  context.add('one', [first]);
  first.text = 'later editor edit';
  const snapshot = context.list('one')[0]!;
  assert.equal(snapshot.text, 'unsaved text');
  snapshot.text = 'mutated caller';
  assert.equal(context.list('one')[0]!.text, 'unsaved text');
  assert.deepEqual(context.list('two'), []);
  assert.throws(() => context.remove('two', snapshot.id!), /session/);
  assert.throws(
    () => contextSnapshot('resource', 'remote', 'https://example.com', 'text'),
    /selected/,
  );
  assert.throws(() => contextSnapshot('file', 'binary', 'file:///binary', '\0'), /smaller text/);
  assert.throws(
    () => contextSnapshot('file', 'huge', 'file:///huge', 'x'.repeat(64_001)),
    /smaller/,
  );
  context.add('one', [
    contextSnapshot('selection', 'file.txt:1', 'file:///file.txt', 'replacement'),
  ]);
  assert.equal(context.list('one').length, 1);
  const saved = context.list('one');
  assert.throws(
    () =>
      context.set(
        'one',
        Array.from({ length: 9 }, (_, index) =>
          contextSnapshot('file', `${index}.txt`, `file:///${index}.txt`, 'text'),
        ),
      ),
    /eight/,
  );
  assert.deepEqual(context.list('one'), saved);
  context.remove('one', saved[0]!.id!);
  assert.deepEqual(context.list('one'), []);
  context.clear('one');
  assert.equal(promptBlocks('hello', saved).length, 2);
});

test('image context captures immutable bytes, sends actual image blocks and replays snapshots after removal', () => {
  const context = new ContextAttachments();
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const snapshot = imageContextSnapshot(
    'chart.png',
    'file:///chart.png',
    imagePayload('image/png', bytes),
  );
  context.add('owner', [snapshot]);
  const captured = context.capture('owner');
  bytes.fill(0);
  snapshot.image!.data = 'changed after selection';
  const saved = context.list('owner')[0]!;
  const blocks = promptBlocks('Inspect this snapshot', captured);
  assert.equal(blocks[2]!.type, 'image');
  assert.equal((blocks[2] as { mimeType: string }).mimeType, 'image/png');
  assert.deepEqual(
    decodeImage(saved.image!),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
  );
  context.remove('owner', saved.id!);
  assert.deepEqual(context.list('owner'), []);
  assert.deepEqual(
    promptBlocks('replay', context.capture('owner', captured)).slice(1),
    blocks.slice(1),
  );
  assert.deepEqual(context.list('other'), []);
  context.restore('owner', { attachments: captured }, true);
  assert.deepEqual(context.list('owner')[0]!.image, saved.image);
});

test('image snapshots enforce MIME, canonical data, decoded and aggregate limits without weakening text limits', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const type of ['image/svg+xml', 'text/html', 'image/gif'])
    assert.throws(() => imagePayload(type, png));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(524_289), Buffer.from('not PNG')])
    assert.throws(() => imagePayload('image/png', bytes));
  assert.equal(
    imageSchema.safeParse({ mimeType: 'image/png', data: png.toString('base64') + '\n' }).success,
    false,
  );
  assert.throws(
    () => decodeImage({ mimeType: 'image/png', data: 'a'.repeat(699_053) }),
    /encoded limit/,
  );
  const context = new ContextAttachments();
  const large = Buffer.alloc(524_288);
  png.copy(large);
  const image = imagePayload('image/png', large);
  const first = imageContextSnapshot('first.png', 'file:///first.png', image);
  context.add('owner', [first, imageContextSnapshot('second.png', 'file:///second.png', image)]);
  assert.throws(
    () =>
      context.add('owner', [
        imageContextSnapshot('third.png', 'file:///third.png', imagePayload('image/png', png)),
      ]),
    /1 MiB/,
  );
  assert.equal(context.list('owner').length, 2);
  assert.throws(() => context.add('owner', [{ ...first, kind: 'file' }]), /requires an image/);
  assert.throws(() => context.add('owner', [{ ...first, image: undefined }]), /missing/);
});
