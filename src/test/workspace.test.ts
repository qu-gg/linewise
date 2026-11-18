import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
  Document,
  fixture,
  reset,
  seedFile,
  FileType,
  FileSystemError,
  Uri,
} from './vscode-fixture.js';

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const vscode = await import('vscode');
const { WorkspaceFiles } = await import('../workspace.js');
beforeEach(reset);
const target = '/workspace/file.txt';
const files = () => new WorkspaceFiles(vscode.Uri.file('/workspace'));

test('workspace reads preserve unsaved buffers and missing unsaved documents', async () => {
  seedFile(target, 'disk');
  fixture.documents.push(new Document(Uri.file(target), 'unsaved user work'));
  assert.equal(await files().read(target), 'unsaved user work');
  fixture.disk.delete(target);
  assert.equal(await files().read(target), 'unsaved user work');
  fixture.documents.length = 0;
  assert.equal(await files().read(target), null);
});

test('workspace reads reject non-text, unsupported types, size and permission errors', async () => {
  for (const bytes of [
    new Uint8Array([0xef, 0xbb, 0xbf, 65]),
    new Uint8Array([0xff]),
    new Uint8Array([65, 0]),
  ]) {
    seedFile(target, bytes);
    await assert.rejects(files().read(target));
  }
  for (const type of [FileType.Directory, FileType.SymbolicLink]) {
    seedFile(target, '', type);
    await assert.rejects(files().read(target), /regular text/);
  }
  seedFile(target, 'valid');
  fixture.disk.get(target)!.size = 1024 * 1024 + 1;
  await assert.rejects(files().read(target), /1 MiB/);
  fixture.fileError = new FileSystemError('NoPermissions');
  await assert.rejects(files().read(target), /NoPermissions/);
});

test('normalization retains CRLF and remote resource identity', async () => {
  seedFile(target, 'existing\r\ntext\r\n');
  assert.equal(await files().normalize(target, 'first\nsecond\r\n'), 'first\r\nsecond\r\n');
  assert.equal(
    await files().normalize('/workspace/new.txt', 'first\r\nsecond\n'),
    'first\nsecond\n',
  );
  const remote = new WorkspaceFiles(
    vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/workspace' }),
  );
  assert.equal(remote.uri(target).scheme, 'vscode-remote');
  assert.equal(remote.uri(target).authority, 'ssh-remote+host');
});

test('workspace replaces and creates through edits, saves, and deletes only expected text', async () => {
  await files().replace(target, null, 'created');
  assert.equal(await files().read(target), 'created');
  await files().replace(target, 'created', 'changed');
  assert.equal(new TextDecoder().decode(fixture.disk.get(target)!.bytes), 'changed');
  await assert.rejects(files().replace(target, 'stale', 'overwrite'), /changed before/);
  assert.equal(await files().read(target), 'changed');
  await files().replace(target, 'changed', null);
  assert.equal(fixture.disk.has(target), false);
});

test('unsupported encoding, rejected edits and failed saves cannot report a successful write', async () => {
  fixture.configuration.set('files.encoding', 'utf16le');
  await assert.rejects(files().replace(target, null, 'unsafe'), /UTF-8/);
  assert.equal(fixture.disk.has(target), false);
  fixture.configuration.clear();
  fixture.applyAllowed = false;
  await assert.rejects(files().replace(target, null, 'rejected'), /rejected the file/);
  assert.equal(fixture.disk.has(target), false);
  fixture.applyAllowed = true;
  fixture.saveAllowed = false;
  await assert.rejects(files().replace(target, null, 'unsaved'), /Pending review/);
  assert.equal(fixture.documents[0]!.text, 'unsaved');
  assert.equal(fixture.documents[0]!.isDirty, true);
});

test('destructive preflight refuses dirty buffers and ignores clean stale documents after deletion', async () => {
  seedFile(target, 'disk');
  const document = new Document(Uri.file(target), 'dirty');
  fixture.documents.push(document);
  await assert.rejects(files().preflightDelete(target), /dirty buffer/);
  await assert.rejects(files().replace(target, 'dirty', null), /dirty buffer/);
  assert.equal(await files().read(target), 'dirty');
  document.text = 'disk';
  document.isDirty = false;
  await files().preflightDelete(target);
  await files().replace(target, 'disk', null);
  assert.equal(await files().read(target), null);
});

test('workspace rename refuses dirty, colliding and stale images and saves edited destination text', async () => {
  const destination = '/workspace/moved.txt';
  seedFile(target, 'before');
  const document = new Document(Uri.file(target), 'before');
  fixture.documents.push(document);
  await assert.rejects(files().move(target, destination, 'before', 'after'), /dirty buffer/);
  document.isDirty = false;
  await assert.rejects(files().move(target, destination, 'stale', 'after'), /changed/);
  seedFile(destination, 'user destination');
  await assert.rejects(files().move(target, destination, 'before', 'after'), /changed/);
  fixture.disk.delete(destination);
  fixture.applyAllowed = false;
  await assert.rejects(files().move(target, destination, 'before', 'after'), /rejected/);
  fixture.applyAllowed = true;
  await files().move(target, destination, 'before', 'before');
  assert.equal(await files().read(target), null);
  assert.equal(document.uri.path, destination);
  await files().move(destination, target, 'before', 'after');
  assert.equal(await files().read(target), 'after');
  assert.equal(await files().read(destination), null);
});
