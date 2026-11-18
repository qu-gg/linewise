import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 11)) {
  console.error(
    'Quality checks require Node 24.11+ (24 LTS recommended). Select Node 24, then run npm ci. See QUALITY.md. The extension runtime is unchanged.',
  );
  process.exit(1);
}

export function run(script, args = [], env = process.env) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tasks = {
  lint: () => run('node_modules/eslint/bin/eslint.js', ['.', '--max-warnings', '0']),
  format: () => run('node_modules/prettier/bin/prettier.cjs', ['--check', '.']),
  typecheck: () => run('node_modules/typescript-compiler/bin/tsc', ['-p', '.', '--noEmit']),
  selftest: () => run('--test', ['quality/metrics.test.mjs', 'quality/architecture.test.mjs']),
  coverage: () => run('scripts/coverage.mjs'),
  metrics: () => run('quality/metrics.mjs'),
  architecture: () => run('quality/architecture.mjs'),
};

function nativeTests() {
  run('node_modules/typescript-compiler/bin/tsc', ['-p', '.']);
  run('scripts/build.mjs');
  run('scripts/acp-spike.mjs', [], {
    ...process.env,
    OMP_SPIKE_TERMINALS: '1',
    OMP_SPIKE_HISTORY: '0',
    OMP_SPIKE_PROMPT: '0',
    OMP_SPIKE_CONTEXT: '0',
  });
  run('scripts/test-extension.mjs');
  run('scripts/history-crashes.mjs', [], { ...process.env, VS_OMP_CRASH_STAGES: undefined });
  run('scripts/acp-spike.mjs', [], {
    ...process.env,
    OMP_SPIKE_TOOLS: '1',
    OMP_SPIKE_TERMINALS: '0',
    OMP_SPIKE_HISTORY: '0',
    OMP_SPIKE_PROMPT: '0',
    OMP_SPIKE_CONTEXT: '0',
  });
}

function unitTests() {
  run('node_modules/typescript-compiler/bin/tsc', ['-p', '.']);
  run('scripts/build.mjs');
  const tests = readdirSync('dist/test')
    .filter((file) => file.endsWith('.test.js'))
    .map((file) => `dist/test/${file}`);
  if (!tests.length) throw new Error('No deterministic tests were discovered.');
  run('--test', tests);
}

function check() {
  for (const [name, action] of Object.entries(tasks)) {
    console.log(`Quality check: ${name}`);
    action();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] ?? 'check';
  if (tasks[command]) tasks[command]();
  else if (command === 'test') unitTests();
  else if (command === 'check') check();
  else if (command === 'native') nativeTests();
  else if (command === 'release') {
    check();
    nativeTests();
  } else throw new Error(`Unknown quality command: ${command}`);
}
