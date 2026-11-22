import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { decodeImage, imagePayload, type ImagePayload } from './image-policy.js';
import { imageContextSnapshot } from './context.js';
import type { Attachment } from './state.js';
import path from 'node:path';

export class ImageSnapshots implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  capture(image: ImagePayload): vscode.Uri {
    const data = decodeImage(image);
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[
      image.mimeType
    ];
    const uri = vscode.Uri.parse(`omp-image:/${randomUUID()}.${extension}`);
    this.entries.set(uri.toString(), data);
    this.bytes += data.byteLength;
    while (this.entries.size > 8 || this.bytes > 1_048_576) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.byteLength;
      this.entries.delete(oldest);
    }
    return uri;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.data(uri).byteLength };
  }
  readFile(uri: vscode.Uri): Uint8Array {
    return new Uint8Array(this.data(uri));
  }
  watch(): vscode.Disposable {
    return { dispose() {} };
  }
  readDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  dispose(): void {
    this.entries.clear();
    this.bytes = 0;
    this.changes.dispose();
  }

  private data(uri: vscode.Uri): Buffer {
    const data = this.entries.get(uri.toString());
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return data;
  }
}

export async function pickImageContext(host: vscode.Uri): Promise<Attachment[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFolders: false,
    openLabel: 'Attach Images',
    filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] },
  });
  if ((picked?.length ?? 0) > 8) throw new Error('Choose at most eight image snapshots.');
  const snapshots: Attachment[] = [];
  let bytes = 0;
  for (const uri of picked ?? []) {
    const image = await pickedImage(host, uri, 1_048_576 - bytes);
    bytes += image.bytes;
    snapshots.push(image.snapshot);
  }
  return snapshots;
}

export async function pickedImage(host: vscode.Uri, uri: vscode.Uri, remaining: number) {
  if (uri.scheme !== host.scheme || uri.authority !== host.authority)
    throw new Error('Choose an image on the active workspace host.');
  const metadata = await vscode.workspace.fs.stat(uri);
  if (metadata.type !== vscode.FileType.File || metadata.size > 524_288)
    throw new Error('Choose regular images up to 512 KiB.');
  if (metadata.size > remaining) throw new Error('Choose images totaling at most 1 MiB.');
  const mime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  const type = mime[path.extname(uri.path).toLowerCase()];
  if (!type) throw new Error('Choose PNG, JPEG or WebP images only.');
  const data = await vscode.workspace.fs.readFile(uri);
  const image = imagePayload(type, data);
  if (data.byteLength > remaining) throw new Error('Choose images totaling at most 1 MiB.');
  return {
    snapshot: imageContextSnapshot(path.basename(uri.path), uri.toString(), image),
    bytes: data.byteLength,
  };
}
