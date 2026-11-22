import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export class PathGuard {
  constructor(private readonly roots: readonly string[]) {}

  async authorizeRead(
    target: string,
    approve: (target: string) => Promise<boolean>,
    signal?: AbortSignal,
    approvedPath?: string,
  ): Promise<string> {
    signal?.throwIfAborted();
    const scope = await this.resolve(target);
    if (!scope.inside && scope.path !== approvedPath && !(await approve(scope.path)))
      throw new Error('Outside-workspace read was not approved.');
    signal?.throwIfAborted();
    if ((await this.resolve(target)).path !== scope.path)
      throw new Error('Filesystem target changed during read approval.');
    return scope.path;
  }

  async resolve(target: string): Promise<{ path: string; inside: boolean }> {
    if (!path.isAbsolute(target) || target.includes('\0') || target.split(/[\\/]/).includes('..')) {
      throw new Error('Only absolute filesystem paths without traversal are supported.');
    }
    const resolved = await this.canonical(target);
    const roots = await Promise.all(this.roots.map((root) => realpath(root)));
    const inside = roots.some((root) => {
      const relative = path.relative(root, resolved);
      return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      );
    });
    return { path: resolved, inside };
  }

  private async canonical(target: string): Promise<string> {
    try {
      return await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const metadata = await lstat(target).catch((failure) => {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
        return null;
      });
      if (metadata?.isSymbolicLink())
        throw new Error('Cannot establish the scope of a dangling symbolic link.', {
          cause: error,
        });
      const parent = path.dirname(target);
      if (parent === target) throw error;
      return path.join(await this.canonical(parent), path.basename(target));
    }
  }
}
