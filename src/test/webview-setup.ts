import { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const runtimeErrors: string[] = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error.message));
export const dom = new JSDOM('<!doctype html><main id="app"></main>', {
  url: 'https://webview.example/',
  virtualConsole,
});
export const messages: Record<string, unknown>[] = [];
const frames: FrameRequestCallback[] = [];
let state: Record<string, unknown>;
let session = 0;
export let remembered: {
  expanded?: Record<string, boolean>;
  draft?: string;
  editing?: { pending: boolean; text: string };
  drafts?: Record<string, string>;
} = {};

let wide = false;
const layoutListeners = new Set<() => void>();
const mediaQuery = {
  get matches() {
    return wide;
  },
  media: '',
  onchange: null,
  addListener(listener: () => void) {
    layoutListeners.add(listener);
  },
  removeListener(listener: () => void) {
    layoutListeners.delete(listener);
  },
  addEventListener(type: string, listener: () => void) {
    if (type === 'change') layoutListeners.add(listener);
  },
  removeEventListener(type: string, listener: () => void) {
    if (type === 'change') layoutListeners.delete(listener);
  },
  dispatchEvent() {
    return false;
  },
};
export function viewport(value: boolean, notify = false) {
  wide = value;
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => mediaQuery });
  if (notify) for (const listener of layoutListeners) listener();
}

before(async () => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    File: dom.window.File,
    FileReader: dom.window.FileReader,
    acquireVsCodeApi: () => ({
      getState: () => ({}),
      setState: (value: typeof remembered) => {
        remembered = structuredClone(value);
      },
      postMessage: (value: Record<string, unknown>) => messages.push(value),
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  viewport(false);
  await import(new URL('../../media/main.js', import.meta.url).href);
  assert.equal(messages[0]!.type, 'ready');
});
after(() => dom.window.close());

export function message(value: object) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { v: 1, ...value } }));
  for (const callback of frames.splice(0)) callback(0);
}
export function update(value: Record<string, unknown>) {
  state = { ...state, ...value };
  message({ type: 'state', state });
}
export function element<Kind extends HTMLElement = HTMLElement>(selector: string): Kind {
  const found = dom.window.document.querySelector<Kind>(selector);
  assert.ok(found, `Missing element: ${selector}`);
  return found;
}
export function click(action: string) {
  element<HTMLButtonElement>(`[data-action="${action}"]`).click();
}
export function input(selector: string, value: string) {
  const field = element<HTMLTextAreaElement>(selector);
  field.value = value;
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
export function turn(blocks: object[] = [{ id: 'answer', kind: 'text', text: 'Answer' }]) {
  return {
    id: 'turn',
    prompt: 'Original prompt',
    status: 'completed',
    startedAt: 1,
    endedAt: 1001,
    blocks,
    history: { beforeEntryId: 'before', afterEntryId: 'after' },
  };
}
beforeEach(() => {
  viewport(false);
  state = {
    turns: [],
    changes: [],
    configs: [],
    sessionId: `session-${++session}`,
    session: 'Test',
    workspace: 'workspace',
    host: 'Local',
    connected: true,
    busy: false,
    connecting: false,
    canHistory: true,
    canCompact: true,
    canInspectContext: true,
  };
  update({});
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  messages.length = 0;
});

afterEach(() => {
  assert.deepEqual(runtimeErrors.splice(0), []);
});
