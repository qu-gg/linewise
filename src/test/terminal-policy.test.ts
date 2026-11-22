import test from 'node:test';
import assert from 'node:assert/strict';
import { commandDecision } from '../terminal-policy.js';
import type { PermissionMode } from '../terminal-policy.js';
import type { TerminalCommand } from '../terminal.js';

const shell = (source: string): TerminalCommand => ({
  command: '/bin/bash',
  args: ['-lc', source],
  cwd: '/workspace',
  env: {},
  outputByteLimit: 65536,
});

test('rules auto-approve only supported read-only command compositions', () => {
  for (const source of [
    'pwd',
    'ls -la',
    'find . -name README.md',
    'git status --short',
    'rg pattern src | head -n 5',
    'cat "a b.txt" && wc -l x',
    'pwd; ls',
    'grep x y || head y',
  ]) {
    assert.equal(commandDecision(shell(source), 'rules'), 'allow', source);
    assert.equal(commandDecision(shell(source), 'ask'), 'ask', source);
  }
  for (const source of [
    'npm test',
    'blender scene.blend',
    'find . -exec rm file ;',
    'find . -delete',
    'find . -fprint out',
    'rg --pre=evil pattern',
    'rg --hostname-bin evil pattern',
    'git -c alias.x=evil x',
    'git reset --hard',
    'rm file',
    'sudo ls',
    'curl example.com',
  ]) {
    assert.equal(commandDecision(shell(source), 'rules'), 'ask', source);
  }
});

test('uncertain syntax, wrappers and environment overrides require a person in conservative modes', () => {
  for (const mode of ['rules', 'all'] as const) {
    for (const source of [
      'ls > file',
      'cat < file',
      'ls &',
      'cat $(touch x)',
      'echo `id`',
      'ls $HOME',
      'ls *.txt',
      'ls\npwd',
      'ls # comment',
      'ls &&',
      'ls "unterminated',
      'A=x ls',
      'ls \u202efile',
      '(pwd)',
      '{ ls; }',
      'ls |& head',
      '! rm x',
      'command rm x',
      'xargs rm',
      '/usr/bin/xargs rm',
      'timeout 5 rm x',
    ]) {
      assert.equal(commandDecision(shell(source), mode), 'ask', `${mode}: ${source}`);
    }
    assert.equal(commandDecision({ ...shell('ls'), env: { PATH: '/tmp' } }, mode), 'ask');
    assert.equal(commandDecision({ ...shell('ls'), args: ['-c', 'ls', 'extra'] }, mode), 'ask');
    assert.equal(commandDecision({ ...shell('ls'), command: 'fish' }, mode), 'ask');
    assert.equal(
      commandDecision({ ...shell('ls'), command: '/usr/bin/xargs', args: ['rm'] }, mode),
      'ask',
    );
    assert.equal(
      commandDecision({ ...shell('ls'), command: 'bash', args: ['-c', 'ls'] }, mode),
      'allow',
    );
  }
  assert.equal(commandDecision(shell('npm test'), 'all'), 'allow');
  assert.equal(commandDecision({ ...shell('pwd'), args: ['-l', '-c', 'pwd'] }, 'rules'), 'allow');
  assert.equal(commandDecision(shell('rm file'), 'all'), 'ask');
  assert.equal(commandDecision(shell('rm file'), 'all', [], false), 'allow');
});

test('explicit deny and ask outrank allows and all modes, including compound and assignment forms', () => {
  const rules = [
    { command: ['git'], action: 'allow' },
    { command: ['git', 'push'], action: 'ask' },
    { command: ['git', 'push', '--force'], action: 'deny' },
  ];
  for (const mode of ['ask', 'rules', 'all'] satisfies PermissionMode[]) {
    assert.equal(commandDecision(shell('git push'), mode, rules), 'ask');
    assert.equal(commandDecision(shell('git push --force'), mode, rules), 'deny');
    assert.equal(commandDecision(shell('pwd && git push --force'), mode, rules), 'deny');
    assert.equal(commandDecision(shell('A=x git push --force'), mode, rules), 'deny');
    assert.equal(commandDecision(shell('/usr/bin/git push --force'), mode, rules), 'deny');
  }
});

test('user rules match literal argv prefixes or exact commands, never arbitrary regex or substrings', () => {
  const rules = [{ command: ['npm', 'test'], action: 'allow', match: 'exact' }];
  assert.equal(commandDecision(shell('npm test'), 'rules', rules), 'allow');
  assert.equal(commandDecision(shell('npm test extra'), 'rules', rules), 'ask');
  assert.equal(commandDecision(shell('npm test && rm x'), 'rules', rules), 'ask');
  assert.equal(commandDecision(shell('npm tester'), 'rules', rules), 'ask');
  assert.equal(
    commandDecision(shell('rm x'), 'rules', [{ command: ['rm'], action: 'allow' }]),
    'allow',
  );
  assert.equal(commandDecision(shell('ls'), 'rules', [], false), 'ask');
  assert.throws(
    () => commandDecision(shell('ls'), 'all', [], null as unknown as boolean),
    /Invalid OMP command rules/,
  );
  assert.equal(commandDecision({ ...shell(''), command: '/tmp/cat', args: ['x'] }, 'rules'), 'ask');
  assert.equal(
    commandDecision({ ...shell(''), command: '/usr/bin/cat', args: ['x'] }, 'rules'),
    'allow',
  );
  assert.equal(
    commandDecision({ ...shell('ls'), env: { PI_SESSION_ID: 'native' } }, 'rules'),
    'allow',
  );
  for (const invalid of [
    null,
    {},
    [{ command: [], action: 'allow' }],
    [{ command: ['ls'], action: 'oops' }],
    [{ command: ['ls'], action: 'allow', typo: true }],
  ]) {
    assert.throws(() => commandDecision(shell('ls'), 'all', invalid), /Invalid OMP command rules/);
  }
});

test('YOLO auto-approves ordinary commands including shell syntax without changing safer modes', () => {
  for (const source of [
    'npm test',
    'rm -rf dist',
    'curl https://example.com',
    'git reset --hard',
    'ls > listing.txt',
    'printf "%s" "$HOME"',
    'echo $(pwd)',
    'for file in *.ts; do echo "$file"; done',
    'env NODE_ENV=test npm test',
    'bash -c "npm test"',
    'npm test\nnpm run build',
    'printf "%s" "hello\nrm -rf /"',
    'dd if=/dev/zero of=/dev/null',
  ])
    assert.equal(commandDecision(shell(source), 'yolo'), 'allow', source);
  assert.equal(
    commandDecision({ ...shell('npm test'), env: { NODE_ENV: 'test' } }, 'yolo'),
    'allow',
  );
  assert.equal(commandDecision(shell('rm -rf dist'), 'all'), 'ask');
});

test('YOLO blocks recognizable machine destruction even when user rules allow it', () => {
  for (const source of [
    'rm -rf /',
    'rm --recursive --force /home/user',
    'rm -rf "$HOME"',
    'rm -rf .',
    'rm -rf /etc/*',
    'rm -rf /etc/',
    'rm -rf ~/*',
    'rm -rf "$HOME/"',
    'rm -rf "$HOME"/*',
    'echo harmless\nrm -rf /',
    'bash -c "echo harmless\nrm -rf /"',
    'sudo -n rm -rf /',
    'env FOO=bar rm -rf /',
    'bash -c "rm -rf /"',
    'mkfs.ext4 /dev/sda',
    '/sbin/wipefs /dev/sda',
    'dd if=/dev/zero of=/dev/sda',
    'echo empty > /dev/nvme0n1',
    'shutdown now',
    'reboot',
    ':(){ :|:& };:',
  ])
    assert.equal(
      commandDecision(shell(source), 'yolo', [{ command: ['rm'], action: 'allow' }]),
      'deny',
      source,
    );
  assert.equal(
    commandDecision({ ...shell(''), command: '/sbin/mkfs.ext4', args: ['/dev/sda'] }, 'yolo'),
    'deny',
  );
  assert.equal(
    commandDecision({ ...shell(''), command: '/bin/echo', args: ['mkfs /dev/sda'] }, 'yolo'),
    'allow',
  );
});

test('YOLO preserves explicit restrictions and invalid-rule fail-closed behavior', () => {
  const rules = [
    { command: ['npm'], action: 'allow' },
    { command: ['npm', 'publish'], action: 'deny' },
    { command: ['git', 'push'], action: 'ask' },
  ];
  assert.equal(commandDecision(shell('npm test && npm publish'), 'yolo', rules), 'deny');
  assert.equal(commandDecision(shell('npm test\nnpm publish'), 'yolo', rules), 'deny');
  assert.equal(commandDecision(shell('npm test\ngit push'), 'yolo', rules), 'ask');
  assert.equal(
    commandDecision(shell('printf "%s" "hello\nworld"'), 'yolo', [
      { command: ['printf', '%s', 'hello\nworld'], action: 'deny', match: 'exact' },
    ]),
    'deny',
  );
  assert.equal(commandDecision(shell('git push'), 'yolo', rules), 'ask');
  assert.throws(
    () => commandDecision(shell('npm test'), 'yolo', null),
    /Invalid OMP command rules/,
  );
});
