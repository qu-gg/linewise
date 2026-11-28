import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { reviewHunks } from '../review-hunks.js';
import { fixture } from './review-fixture.js';

test('editable proposals stay off disk until Keep, reset to the suggestion, and refuse stale bytes', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'proposal.txt');
  current.data.set(target, 'baseline\n');
  await current.journal.write('session', target, 'suggested\n');
  const change = current.journal.list()[0]!;
  await current.journal.updateProposal(change.id, 'edited in review\n');
  assert.equal(current.data.get(target), 'suggested\n');
  assert.equal(current.journal.list()[0]!.after, 'edited in review\n');
  assert.equal(current.journal.list()[0]!.applied, 'suggested\n');
  await current.journal.resetProposal(change.id);
  assert.equal(current.journal.list()[0]!.after, 'suggested\n');
  assert.equal(current.journal.list()[0]!.suggestion, 'suggested\n');
  await current.journal.updateProposal(change.id, 'edited again\n');
  await current.journal.keep(change.id);
  assert.equal(current.data.get(target), 'edited again\n');
  assert.deepEqual(current.journal.list(), []);
});

test('editable proposals and hunk controls refuse external bytes and require reset first', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'proposal-refusal.txt');
  const before = Array.from({ length: 8 }, (_, index) => `line ${index}\n`).join('');
  current.data.set(target, before);
  await current.journal.write('session', target, before.replace('line 0', 'suggested'));
  const change = current.journal.list()[0]!;
  await current.journal.updateProposal(change.id, before.replace('line 0', 'edited'));
  await assert.rejects(
    current.journal.resolveHunk(change.id, reviewHunks(current.journal.list()[0]!)[0]!.id, 'keep'),
    /Reset to suggestion/,
  );
  await current.journal.resetProposal(change.id);
  current.data.set(target, 'external\n');
  await assert.rejects(
    current.journal.updateProposal(change.id, 'another proposal\n'),
    /newer user or external/,
  );
  assert.equal(current.journal.list()[0]!.state, 'conflict');
  assert.equal(current.data.get(target), 'external\n');
});

test('Keep and Reset refuse external disk changes and do not remove conflicted proposals', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'proposal-conflict.txt');
  current.data.set(target, 'baseline\n');
  await current.journal.write('session', target, 'suggested\n');
  const change = current.journal.list()[0]!;
  await current.journal.updateProposal(change.id, 'edited\n');
  current.data.set(target, 'external\n');
  await assert.rejects(current.journal.keep(change.id), /newer user or external/);
  assert.equal(current.journal.list()[0]!.state, 'conflict');
  const missing = await fixture();
  context.after(missing.cleanup);
  const deleted = path.join(missing.root, 'deleted.txt');
  missing.data.set(deleted, 'baseline');
  await missing.journal.delete('session', deleted);
  const deleteChange = missing.journal.list()[0]!;
  await assert.rejects(missing.journal.resetProposal(deleteChange.id), /does not support/);
  await assert.rejects(missing.journal.updateProposal(deleteChange.id, 'text'), /does not support/);
});

test('Keep reports a save participant that changes the proposal during the write', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'proposal-save.txt');
  current.data.set(target, 'baseline\n');
  await current.journal.write('session', target, 'suggested\n');
  const change = current.journal.list()[0]!;
  await current.journal.updateProposal(change.id, 'edited\n');
  const replace = current.files.replace.bind(current.files);
  current.files.replace = async (file, expected, content) => {
    await replace(file, expected, content);
    current.data.set(file, 'save participant changed this');
  };
  await assert.rejects(current.journal.keep(change.id), /changed the file unexpectedly/);
  assert.equal(current.journal.list()[0]!.state, 'conflict');
  assert.equal(current.data.get(target), 'save participant changed this');
});

test('Reset refuses an external preimage and leaves the proposal conflicted', async (context) => {
  const current = await fixture();
  context.after(current.cleanup);
  const target = path.join(current.root, 'proposal-reset-conflict.txt');
  current.data.set(target, 'baseline\n');
  await current.journal.write('session', target, 'suggested\n');
  const change = current.journal.list()[0]!;
  await current.journal.updateProposal(change.id, 'edited\n');
  current.data.set(target, 'external\n');
  await assert.rejects(current.journal.resetProposal(change.id), /newer user or external/);
  assert.equal(current.journal.list()[0]!.state, 'conflict');
  assert.equal(current.data.get(target), 'external\n');
});
