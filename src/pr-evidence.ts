import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { agentRuntimeEnvironment } from './host-runtime.js';

export interface CommandResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<CommandResult>;

export type GitRunner = (args: string[], cwd: string, signal: AbortSignal) => Promise<string>;

export interface PullRequestEvidence {
  branch: string;
  base: string;
  baseSha: string;
  ahead: number;
  behind: number;
  script: string;
  output: string;
  truncated: boolean;
  files: string[];
}

interface CollectOptions {
  cwd: string;
  signal: AbortSignal;
  run?: CommandRunner;
  git?: GitRunner;
  report?: (message: string) => void;
}

const CAPTURE_BYTES = 64 * 1024;
const BODY_OUTPUT_BYTES = 4 * 1024;

function append(output: string, chunk: string): { output: string; truncated: boolean } {
  const next = output + chunk;
  if (Buffer.byteLength(next) <= CAPTURE_BYTES) return { output: next, truncated: false };
  return { output: next.slice(-CAPTURE_BYTES), truncated: true };
}

export const runCommand: CommandRunner = (command, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    const environment = Object.fromEntries(
      agentRuntimeEnvironment('auto', cwd).map(({ name, value }) => [name, value]),
    );
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let truncated = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: string) => {
        const next = append(output, chunk);
        output = next.output;
        truncated ||= next.truncated;
      });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (exitCode) => finish({ exitCode, output, truncated }));
    signal.addEventListener(
      'abort',
      () => {
        if (settled) return;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
        settled = true;
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function verificationScript(packageBody: unknown): string {
  const scripts = (packageBody as { scripts?: Record<string, unknown> } | undefined)?.scripts;
  if (!scripts || typeof scripts !== 'object')
    throw new Error('package.json has no scripts block.');
  for (const name of ['check', 'verify', 'test'])
    if (typeof scripts[name] === 'string') return name;
  throw new Error('package.json has no check, verify, or test script.');
}

function tail(value: string, limit: number): string {
  return value.length > limit ? `…\n${value.slice(-limit)}` : value;
}

export function formatPullRequestBody(evidence: PullRequestEvidence): string {
  const base = evidence.baseSha.slice(0, 12);
  return [
    '## User Impact',
    '',
    '<!-- Describe the user-visible change and link the issue or PRV task. -->',
    '',
    '## Cause And Change',
    '',
    '<!-- Describe the root cause and the smallest useful fix. -->',
    '',
    '## Verification',
    '',
    `- Branch \`${evidence.branch}\` against \`${evidence.base}\` at \`${base}\`: ${evidence.ahead} ahead, ${evidence.behind} behind.`,
    `- \`npm run ${evidence.script}\` passed (exit 0).`,
    '',
    '```text',
    tail(evidence.output, BODY_OUTPUT_BYTES).trim(),
    '```',
    '',
    '## Changed Files',
    '',
    ...(evidence.files.length ? evidence.files.map((file) => `- \`${file}\``) : ['- None.']),
    '',
    '## Review Checklist',
    '',
    '- [ ] I understand and reviewed the change, including AI-assisted code.',
    '- [ ] Tests and docs match the behavior; I did not lower quality gates.',
    '- [ ] No private data or unrelated cleanup is included; third-party provenance/notices are preserved.',
    '- [ ] Any new authority, supported scope, paid inference, or release requirement was discussed with maintainers.',
    '',
  ].join('\n');
}

export async function collectPullRequestEvidence(
  options: CollectOptions,
): Promise<PullRequestEvidence> {
  const { cwd, signal } = options;
  const run = options.run ?? runCommand;
  const report = options.report ?? (() => {});
  const git: GitRunner =
    options.git ??
    (async (args, root, active) => {
      const result = await run('git', args, root, active);
      if (result.exitCode !== 0)
        throw new Error(`git ${args.join(' ')} failed: ${tail(result.output, 1000).trim()}`);
      return result.output.trim();
    });

  const packageBody = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as unknown;
  const script = verificationScript(packageBody);

  report('Checking branch and working tree');
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, signal);
  const base = 'origin/main';
  const baseSha = await git(['rev-parse', '--verify', base], cwd, signal);
  const [behind = 0, ahead = 0] = (
    await git(['rev-list', '--left-right', '--count', `${base}...HEAD`], cwd, signal)
  )
    .split(/\s+/)
    .map(Number);
  const dirty = await git(['status', '--porcelain'], cwd, signal);
  if (dirty)
    throw new Error('Commit or stash working-tree changes before preparing a pull request.');
  if (behind > 0)
    throw new Error(
      `Branch is ${behind} commit(s) behind ${base}. Update it before preparing a pull request.`,
    );

  const files = (await git(['diff', '--name-only', `${base}...HEAD`], cwd, signal))
    .split('\n')
    .filter(Boolean)
    .slice(0, 200);

  report(`Running npm run ${script}`);
  const result = await run('npm', ['run', script], cwd, signal);
  if (result.exitCode !== 0)
    throw new Error(
      `npm run ${script} failed (exit ${result.exitCode ?? 'unknown'}).\n${tail(result.output, BODY_OUTPUT_BYTES).trim()}`,
    );

  return {
    branch,
    base,
    baseSha,
    ahead,
    behind,
    script,
    output: result.output,
    truncated: result.truncated,
    files,
  };
}
