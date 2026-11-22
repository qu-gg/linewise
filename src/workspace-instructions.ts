import { realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function instructionArguments(instructions?: string): string[] {
  return [
    '--no-context-files',
    '--no-rules',
    '--no-skills',
    ...(instructions ? ['--append-system-prompt', instructions] : []),
  ];
}

function assertInstructionPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Workspace instructions must not resolve outside the selected root.');
}

export async function workspaceInstructions(
  root: string,
  read: (target: string) => Promise<string | null>,
): Promise<string> {
  const canonical = await realpath(root);
  for (const name of ['.omp/AGENTS.md', '.github/copilot-instructions.md', 'AGENTS.md']) {
    const target = path.join(canonical, name);
    try {
      const resolved = await realpath(target);
      assertInstructionPath(canonical, resolved);
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size > 65536)
        throw new Error('Workspace instructions must be regular UTF-8 text up to 64 KiB.');
      const text = await read(resolved);
      if (text === null) continue;
      if (Buffer.byteLength(text, 'utf8') > 65536)
        throw new Error('Workspace instruction buffers must not exceed 64 KiB.');
      return `Workspace instructions (${name}); file references are literal, not automatic imports.\n\n${text}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return '';
}

export async function withInstructionSnapshot<Result>(
  directory: string,
  text: string,
  start: (file: string) => Promise<Result>,
): Promise<Result> {
  const file = path.join(directory, `instructions-${randomUUID()}.txt`);
  await writeFile(file, text, { mode: 0o600, flag: 'wx' });
  try {
    return await start(file);
  } finally {
    await rm(file);
  }
}
