import test from 'node:test';
import assert from 'node:assert/strict';
import { dom, messages, element } from './webview-setup.js';

async function paste(clipboardData: {
  items: { kind: string; type: string; getAsFile(): File | null }[];
  text?: string;
}) {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: clipboardData.items,
      getData: () => clipboardData.text ?? '',
    },
  });
  element('#prompt').dispatchEvent(event);
  const before = messages.length;
  for (let attempt = 0; attempt < 50 && messages.length === before; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

test('pasted clipboard images decode into one bounded batch and keep pasted text', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  await paste({
    items: [
      {
        kind: 'file',
        type: 'image/png',
        getAsFile: () => new dom.window.File([png], 'screenshot.png', { type: 'image/png' }),
      },
    ],
    text: 'look at this',
  });
  assert.equal(element<HTMLTextAreaElement>('#prompt').value, 'look at this');
  assert.deepEqual(messages, [
    {
      v: 1,
      type: 'pasteImages',
      images: [{ mimeType: 'image/png', data: 'iVBORw0KGgoBAgM=' }],
    },
  ]);
});

test('oversized pasted images stay local and explain the 512 KiB limit', async () => {
  await paste({
    items: [
      {
        kind: 'file',
        type: 'image/png',
        getAsFile: () =>
          new dom.window.File([new Uint8Array(524_289)], 'large.png', { type: 'image/png' }),
      },
    ],
  });
  assert.equal(messages.length, 0);
  assert.match(element('.attention').textContent!, /512 KiB/);
});
