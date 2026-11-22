import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { imageContextSnapshot } from '../context.js';
import { imagePayload } from '../image-policy.js';
import { notebookImageFixtures } from './live-editor.js';

type Api = Awaited<ReturnType<typeof import('../extension.js').activate>>;

async function assertProviderImage(png: Buffer): Promise<void> {
  const context = JSON.parse(await readFile(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'));
  const images = context.messages
    .flatMap((message: { content?: unknown }) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((block: { type: string }) => block.type === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[0].data, png.toString('base64'));
  const browser = await chromium.launch({
    executablePath: process.env.VS_OMP_LIVE_BROWSER_PATH || '/opt/brave.com/brave/brave',
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const decoded = await page.evaluate(
      async (sources) =>
        Promise.all(
          sources.map(async (source) => {
            const image = new Image();
            image.src = source;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 320;
            const graphics = canvas.getContext('2d')!;
            graphics.drawImage(image, 0, 0);
            return [
              image.width,
              image.height,
              ...[
                [630, 310],
                [50, 130],
                [50, 210],
              ].flatMap(([x, y]) => Array.from(graphics.getImageData(x!, y!, 1, 1).data)),
            ];
          }),
        ),
      [
        `data:image/png;base64,${png.toString('base64')}`,
        `data:${images[0].mimeType};base64,${images[0].data}`,
      ],
    );
    assert.deepEqual(
      decoded[0],
      [640, 320, 255, 255, 255, 255, 21, 128, 61, 255, 249, 115, 22, 255],
    );
    assert.deepEqual(decoded[1]!.slice(0, 2), [640, 320]);
    for (const [index, channel] of decoded[0]!.slice(2).entries())
      assert.ok(
        Math.abs(decoded[1]![index + 2]! - channel) <= 8,
        `Chart channel ${index} changed during conversion`,
      );
  } finally {
    await browser.close();
  }
  assert.doesNotMatch(JSON.stringify(context.messages), /removed-native-image.png/);
}

export async function nativeImageContext(root: vscode.Uri, api: Api): Promise<void> {
  const [chart] = await notebookImageFixtures(path.dirname(process.env.VS_OMP_FIXTURE_CONTEXT!));
  const png = chart!.png;
  await vscode.commands.executeCommand('omp.newSession');
  const uri = vscode.Uri.joinPath(root, 'captured-native-image.png');
  await vscode.workspace.fs.writeFile(uri, png);
  const snapshot = imageContextSnapshot(
    'captured-native-image.png',
    uri.toString(),
    imagePayload('image/png', png),
  );
  const removed = imageContextSnapshot(
    'removed-native-image.png',
    vscode.Uri.joinPath(root, 'removed-native-image.png').toString(),
    imagePayload('image/png', png),
  );
  try {
    await api.attachSnapshots!([snapshot, removed]);
    assert.equal(api.status()!.attachments.length, 2);
    await api.request!({ v: 1, type: 'removeAttachment', id: api.status()!.attachments[1]!.id });
    await vscode.workspace.fs.delete(uri);
    await api.request!({ v: 1, type: 'inspectAttachment', id: api.status()!.attachments[0]!.id });
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri };
    assert.equal(active.uri?.scheme, 'omp-image');
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(active.uri!)), png);
    assert.equal(vscode.workspace.fs.isWritableFileSystem('omp-image'), false);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(active.uri!, png)));
    await api.request!({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
    await api.request!({ v: 1, type: 'prompt', text: 'NATIVE_IMAGE_CONTEXT_INITIAL' });
    await assertProviderImage(png);
    const turn = api.status()!.turns.at(-1)!;
    assert.equal(
      api.storedState!()
        .sessions.find((session) => session.id === api.status()!.sessionId)!
        .turns.at(-1)!.attachments![0]!.image!.data,
      png.toString('base64'),
    );
    await api.request!({
      v: 1,
      type: 'editPrompt',
      id: turn.id,
      text: 'NATIVE_IMAGE_CONTEXT_REPLAY',
    });
    await assertProviderImage(png);
    await reopenedImageReplay(api, png);
    assert.equal(api.status()!.changes.length, 0);
    console.log(
      'PASS: native explicit-fixture image snapshot has read-only byte-exact preview, survives source deletion/removal and reaches actual ACP provider plus historical replay as pixels without rereading.',
    );
  } finally {
    await api.request!({ v: 1, type: 'disconnect' });
  }
}

async function reopenedImageReplay(api: Api, png: Buffer): Promise<void> {
  const sessionId = api.status()!.sessionId!;
  await api.request!({ v: 1, type: 'disconnect' });
  await api.resume!(sessionId);
  await api.request!({ v: 1, type: 'config', id: 'model', value: 'vs-omp-fixture/history' });
  await api.request!({ v: 1, type: 'prompt', text: 'NATIVE_IMAGE_CONTEXT_REOPENED' });
  await assertProviderImage(png);
  await api.request!({
    v: 1,
    type: 'editPrompt',
    id: api.status()!.turns[0]!.id,
    text: 'NATIVE_IMAGE_CONTEXT_REOPENED_REPLAY',
  });
  await assertProviderImage(png);
}
