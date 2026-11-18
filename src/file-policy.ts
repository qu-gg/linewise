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

export function pathReason(target: unknown): string | undefined {
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
    !textExtensions.has(path.extname(target).toLowerCase()) &&
    !['AGENTS.md', '.gitignore', 'Dockerfile', 'Makefile'].includes(path.basename(target))
  )
    return 'This feasibility build supports explicitly recognized text-file types only.';
}

export async function checkedPath(
  target: string,
  cwd: string,
  artifacts = process.env.VS_OMP_ARTIFACTS_ROOT,
): Promise<string> {
  const reason = pathReason(target);
  if (reason) throw new Error(reason);
  const resolved = (await new PathGuard([]).resolve(path.resolve(cwd, target))).path;
  if (
    !artifacts ||
    resolved === artifacts ||
    resolved.startsWith(`${artifacts}${path.sep}`) ||
    /[/\\]\.omp[/\\]agent[/\\]sessions[/\\]/.test(resolved)
  )
    throw new Error(
      'OMP internal session artifacts are not editable through this feasibility build.',
    );
  return resolved;
}
