import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { StateStore } from './state.js';
import { retentionPolicy } from './storage-policy.js';
export { retentionPolicy } from './storage-policy.js';

export interface StoredArtifact {
  name: string;
  size: number;
  modifiedAt: number;
  inode: number;
  device: number;
  owners: string[];
}

async function nativeDirectory(directory: string): Promise<string | undefined> {
  const root = await realpath(directory);
  const native = path.join(root, 'omp-sessions');
  try {
    const info = await lstat(native);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(native)) !== native)
      throw new Error('Native storage is not a private regular directory.');
    return native;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function owners(store: StateStore, name: string): string[] {
  return store.data.sessions
    .filter(
      (saved) =>
        saved.sessionFile === name ||
        saved.historyTransition?.before.fileName === name ||
        (!saved.sessionFile && name.endsWith(`_${saved.id}.jsonl`)),
    )
    .map((saved) => saved.id);
}

export function assertKnownOwnership(store: StateStore): void {
  if (store.data.sessions.some((saved) => !saved.sessionFile && saved.turns.length > 0))
    throw new Error(
      'Native ownership is ambiguous. Reconnect legacy sessions before artifact cleanup.',
    );
}

export async function scanArtifacts(store: StateStore): Promise<StoredArtifact[]> {
  const directory = await nativeDirectory(store.directory);
  if (!directory) return [];
  const entries = await readdir(directory);
  if (entries.length > retentionPolicy.maximumScanFiles)
    throw new Error('Native storage exceeds the scan budget; no artifacts were removed.');
  const result: StoredArtifact[] = [];
  for (const name of entries) {
    if (!/^[\w.-]+\.jsonl$/.test(name)) continue;
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink()) continue;
    result.push({
      name,
      size: info.size,
      modifiedAt: info.mtimeMs,
      inode: info.ino,
      device: info.dev,
      owners: owners(store, name),
    });
  }
  return result;
}

export async function assertNativeBudget(store: StateStore, id: string): Promise<void> {
  const files = await scanArtifacts(store);
  if (
    files.some(
      (file) => file.owners.includes(id) && file.size >= retentionPolicy.maximumArtifactBytes,
    )
  )
    throw new Error(
      'Native session reached its storage budget. Start a new session; existing history is retained.',
    );
}

function unchanged(
  info: { size: number; mtimeMs: number; ino: number; dev: number },
  file: StoredArtifact,
) {
  if (
    info.ino !== file.inode ||
    info.dev !== file.device ||
    info.size !== file.size ||
    info.mtimeMs !== file.modifiedAt
  )
    throw new Error('A native artifact changed; inspect storage again.');
}

export async function readArtifact(store: StateStore, file: StoredArtifact): Promise<string> {
  if (
    !/^[\w.-]+\.jsonl$/.test(file.name) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > retentionPolicy.maximumArtifactBytes
  )
    throw new Error('Native artifact name or size is unsupported.');
  const directory = await nativeDirectory(store.directory);
  if (!directory) throw new Error('Native storage disappeared.');
  const handle = await open(
    path.join(directory, file.name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Native artifact is not a regular file.');
    unchanged(info, file);
    const buffer = Buffer.alloc(file.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    unchanged(await handle.stat(), file);
    if (offset !== file.size) throw new Error('Native artifact changed during export.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export async function removeArtifacts(
  store: StateStore,
  selected: StoredArtifact[],
): Promise<string[]> {
  assertKnownOwnership(store);
  if (selected.length > retentionPolicy.maximumRemovalFiles)
    throw new Error('Select at most 128 native artifacts per cleanup.');
  const removed: string[] = [];
  for (const expected of selected) {
    const current = (await scanArtifacts(store)).find((file) => file.name === expected.name);
    if (!current) continue;
    if (current.owners.length) throw new Error('A native artifact is still referenced.');
    unchanged(
      { size: current.size, mtimeMs: current.modifiedAt, ino: current.inode, dev: current.device },
      expected,
    );
    const directory = await nativeDirectory(store.directory);
    if (!directory) throw new Error('Native storage disappeared.');
    await unlink(path.join(directory, current.name));
    removed.push(current.name);
  }
  return removed;
}

export async function writePrivateExport(file: string, contents: string): Promise<void> {
  if (Buffer.byteLength(contents) > retentionPolicy.maximumExportBytes)
    throw new Error('Export exceeds the private export size limit.');
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } catch (error) {
    const created = await handle.stat();
    const current = await lstat(file).catch(() => undefined);
    if (created.ino === current?.ino && created.dev === current.dev)
      await unlink(file).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}
