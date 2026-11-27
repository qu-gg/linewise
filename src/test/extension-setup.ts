import type { TestContext } from 'node:test';
import type { ExtensionContext } from 'vscode';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { fixture, reset, Uri, view } from './vscode-fixture.js';
import { transport } from './acp-fixture.js';
import { OMP_TESTED_VERSION } from '../omp-version.js';

Object.assign(view, { show: () => {} });

register(new URL('./vscode-loader.js', import.meta.url), import.meta.url);
const vscode = await import('vscode');
const { activate, deactivate } = await import('../extension.js');

export async function setup(context: TestContext, cleanupFailure = false) {
  reset();
  transport.client = undefined;
  transport.backend = 'local';
  transport.version = OMP_TESTED_VERSION;
  transport.configError = undefined;
  transport.nextSessionId = undefined;
  transport.configOptions = undefined;
  transport.onPrompt = async () => {};
  transport.onCancel = () => {};
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-host-unit-'));
  const root = path.join(directory, 'workspace');
  const storage = path.join(directory, 'storage');
  await mkdir(root);
  fixture.roots = [{ name: 'workspace', uri: Uri.file(root), index: 0 }];
  const extensionContext: Pick<
    ExtensionContext,
    'subscriptions' | 'extensionMode' | 'storageUri' | 'globalStorageUri' | 'extensionUri'
  > = {
    subscriptions: [],
    extensionMode: vscode.ExtensionMode.Test,
    storageUri: vscode.Uri.file(storage),
    globalStorageUri: vscode.Uri.file(storage),
    extensionUri: vscode.Uri.file(process.cwd()),
  };
  const extension = await activate(extensionContext as ExtensionContext);
  fixture.provider!.resolveWebviewView(view);
  context.after(async () => {
    try {
      if (cleanupFailure) await assert.rejects(deactivate(), /cleanup failed/);
      else await deactivate();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const request = (message: object) => extension.request!({ v: 1, ...message });
  return { ...extension, request, root, storage, extensionContext };
}

export async function pendingApproval(host: Awaited<ReturnType<typeof setup>>) {
  const deadline = Date.now() + 5000;
  while (!host.status()!.approval) {
    assert.ok(Date.now() < deadline, 'approval did not become visible');
    await tick();
  }
  return host.status()!.approval!;
}

export async function approveNext(host: Awaited<ReturnType<typeof setup>>) {
  const request = await pendingApproval(host);
  await host.request({ type: 'approval', id: request.id, decision: 'allow' });
}
