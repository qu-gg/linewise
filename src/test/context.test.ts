import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextAttachments, contextSnapshot } from '../context.js';
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
