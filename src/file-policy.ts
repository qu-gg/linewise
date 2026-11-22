import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PathGuard } from './review.js';

const textExtensions = new Set([
  '.txt',
  '.md',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.css',
  '.scss',
  '.html',
  '.xml',
  '.csv',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.sh',
  '.sql',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.gitignore',
]);

export function pathReason(target: unknown, textOnly = true): string | undefined {
  if (
    typeof target !== 'string' ||
    !target ||
    /[:\0[\]#?~]/.test(target) ||
    target.split(/[\\/]/).includes('..')
  )
    return 'Use a plain file path without schemes, selectors, wrappers, or traversal.';
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|sqlite3?|db)(?:$|[/\\])/i.test(target))
    return 'Archive and database targets are disabled because they bypass ACP text-file review.';
  if (
    textOnly &&
    !textExtensions.has(path.extname(target).toLowerCase()) &&
    !['AGENTS.md', '.gitignore', 'Dockerfile', 'Makefile'].includes(path.basename(target))
  )
    return 'This feasibility build supports explicitly recognized text-file types only.';
}

export async function checkedPath(
  target: string,
  cwd: string,
  artifacts = process.env.VS_OMP_ARTIFACTS_ROOT,
  textOnly = true,
): Promise<string> {
  const reason = pathReason(target, textOnly);
  if (reason) throw new Error(reason);
  return resolvePath(target, cwd, artifacts);
}

async function resolvePath(
  target: string,
  cwd: string,
  artifacts?: string,
  mutation = true,
): Promise<string> {
  const resolved = (await new PathGuard([]).resolve(path.resolve(cwd, target))).path;
  if (
    !artifacts ||
    resolved === artifacts ||
    resolved.startsWith(`${artifacts}${path.sep}`) ||
    (mutation && /[/\\]\.omp[/\\]agent[/\\]sessions(?:[/\\]|$)/.test(resolved))
  )
    throw new Error(
      'OMP internal session artifacts are not editable through this feasibility build.',
    );
  return resolved;
}

export function readTarget(target: unknown): string {
  if (
    typeof target !== 'string' ||
    !target ||
    target.length > 4096 ||
    /[\0\r\n]/.test(target) ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(target)
  )
    throw new Error('Read requires a bounded local filesystem path.');
  const plain = target.replace(/:(?:raw|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/, '');
  return plain.startsWith('~/') ? path.join(homedir(), plain.slice(2)) : plain;
}

export async function checkedReadPath(
  target: string,
  cwd: string,
  artifacts = process.env.VS_OMP_ARTIFACTS_ROOT,
): Promise<string> {
  const resolved = await resolvePath(readTarget(target), cwd, artifacts, false);
  const metadata = await stat(resolved);
  if (!metadata.isFile() && !metadata.isDirectory())
    throw new Error('Only regular files and directories can be read.');
  return resolved;
}
