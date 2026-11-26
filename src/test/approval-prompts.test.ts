import assert from 'node:assert/strict';
import test from 'node:test';
import { commandApproval, fileApproval, visible } from '../approval-prompts.js';

test('command cards show shell scripts without changing exact execution details', () => {
  const command = {
    command: '/bin/bash',
    args: ['-l', '-c', 'echo first\necho second'],
    cwd: '/workspace',
    env: { EXPLICIT: 'value' },
    outputByteLimit: 100,
  };
  const card = commandApproval(command);
  assert.equal(card.title, 'Run bash command?');
  assert.equal(card.summary, 'echo first\necho second');
  assert.match(card.details, /Executable: "\/bin\/bash"/);
  assert.match(card.details, /EXPLICIT/);
  assert.match(card.details, /Keep\/Discard|Source Control/);
  for (const flag of ['-c', '-lc']) {
    assert.equal(commandApproval({ ...command, args: [flag, 'pwd'] }).summary, 'pwd');
  }
  assert.equal(commandApproval({ ...command, args: [] }).summary, '"/bin/bash"');
  assert.equal(
    commandApproval({ ...command, args: ['-x', '-c', 'pwd'] }).summary,
    '"/bin/bash" "-x" "-c" "pwd"',
  );
  assert.equal(
    commandApproval({ ...command, command: '/bin/echo', args: ['a b', ''] }).summary,
    '"/bin/echo" "a b" ""',
  );
  const control = String.fromCharCode(0x202e);
  assert.equal(
    commandApproval({ ...command, args: ['-c', `visible${control}hidden`] }).summary,
    'visible\\u202ehidden',
  );
  assert.equal(visible('\0\r\n\t'), '\\u0000\\u000d\n\t');
  assert.equal(visible('\u{e0001}'), '\\u{e0001}');
});

test('file cards distinguish reads and mutations and retain full proposed diffs', () => {
  const read = fileApproval({ kind: 'read', path: '/private/file' });
  assert.equal(read.summary, '/private/file');
  assert.match(read.notice, /sent to the configured model/);
  assert.match(read.details, /configured model provider/);
  const moved = fileApproval({
    kind: 'move',
    path: '/from',
    destination: '/to',
    before: 'old',
    after: 'new',
  });
  assert.equal(moved.destination, '/to');
  assert.match(moved.details, /--- \/from/);
  assert.match(moved.details, /\+\+\+ \/to/);
  const created = fileApproval({ kind: 'write', path: '/new', after: 'x'.repeat(7000) });
  assert.ok(created.details.length > 7000);
  const deleted = fileApproval({ kind: 'delete', path: '/old', before: 'gone' });
  assert.match(deleted.details, /-gone/);
});
