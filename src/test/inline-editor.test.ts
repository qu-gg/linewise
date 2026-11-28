import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as modules from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><body data-worker="https://webview.example/inline-worker.js"><div id="toolbar" hidden></div><div id="surface"><main id="editor"></main><div id="overview"></div></div><div id="overview-summary"></div><div id="status" hidden></div></body>',
);
const root = dom.window.document.getElementById('editor')!;
const messages: Record<string, unknown>[] = [];
type Zone = {
  domNode: HTMLElement;
  afterLineNumber: number;
  heightInLines?: number;
  heightInPx?: number;
  onDomNodeTop?: (top: number) => void;
};
const zones = new Map<string, Zone>();
const widgets = new Map<
  string,
  { getId: () => string; getDomNode: () => HTMLElement; getPosition: () => unknown }
>();
const events = new Map<string, (event: unknown) => void>();
const model = {
  text: '',
  getValue: () => model.text,
  setValue: (text: string) => {
    model.text = text;
  },
  getLineCount: () => Math.max(1, model.text.split('\n').length),
  dispose: () => {
    disposed++;
  },
};
let scroll = 0;
let contentHeight = 500;
let disposed = 0;
let additions: unknown[] = [];
let language = '';
let theme: Record<string, unknown>;
let options: Record<string, unknown>;
let revealed = 0;
class Range {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
}
function layoutZones() {
  let offset = 0;
  for (const zone of [...zones.values()].sort(
    (first, second) => first.afterLineNumber - second.afterLineNumber,
  )) {
    zone.onDomNodeTop?.(16 + zone.afterLineNumber * 22 + offset - scroll);
    offset += zone.heightInPx ?? (zone.heightInLines ?? 0) * 22;
  }
}
const instance = {
  getModel: () => model,
  createDecorationsCollection: () => ({
    set: (value: unknown[]) => {
      additions = value;
    },
  }),
  saveViewState: () => ({ scroll }),
  restoreViewState: (value: { scroll: number }) => {
    scroll = value.scroll;
    layoutZones();
  },
  updateOptions: (value: Record<string, unknown>) => {
    options = value;
  },
  revealLineInCenter: (line: number) => {
    revealed = line;
  },
  changeViewZones: (callback: (accessor: unknown) => void) => {
    callback({
      addZone: (zone: Zone) => {
        const id = String(zones.size + 1);
        zones.set(id, zone);
        root.append(zone.domNode);
        return id;
      },
      removeZone: (id: string) => {
        zones.get(id)!.domNode.remove();
        zones.delete(id);
      },
    });
    layoutZones();
  },
  addOverlayWidget: (widget: typeof widgets extends Map<string, infer Value> ? Value : never) => {
    widgets.set(widget.getId(), widget);
    assert.equal(widget.getPosition(), null);
    root.append(widget.getDomNode());
  },
  removeOverlayWidget: (widget: { getId: () => string; getDomNode: () => HTMLElement }) => {
    widgets.delete(widget.getId());
    widget.getDomNode().remove();
  },
  onDidScrollChange: (callback: (event: unknown) => void) =>
    events.set('scroll', (event) => {
      layoutZones();
      callback(event);
    }),
  onDidLayoutChange: (callback: (event: unknown) => void) =>
    events.set('layout', (event) => {
      layoutZones();
      callback(event);
    }),
  onDidChangeCursorPosition: (callback: (event: unknown) => void) => events.set('cursor', callback),
  onDidChangeModelContent: (callback: (event: unknown) => void) => events.set('content', callback),
  getScrollHeight: () => contentHeight,
  getScrollTop: () => scroll,
  setScrollTop: (value: number) => {
    scroll = value;
    layoutZones();
  },
  getLayoutInfo: () => ({ height: 500, verticalScrollbarWidth: 14 }),
  getTopForLineNumber: (line: number) => 16 + Math.max(0, line - 1) * 22,
  getBottomForLineNumber: (line: number) => 16 + Math.max(0, line) * 22,
  dispose: () => {
    disposed++;
  },
};
type Resolve = (specifier: string, context: unknown) => { url: string; shortCircuit?: boolean };
type Load = (
  url: string,
  context: unknown,
) => { format: string; source?: string; shortCircuit?: boolean };
const registerHooks = (
  modules as unknown as {
    registerHooks: (hooks: {
      resolve: (specifier: string, context: unknown, next: Resolve) => ReturnType<Resolve>;
      load: (url: string, context: unknown, next: Load) => ReturnType<Load>;
    }) => { deregister: () => void };
  }
).registerHooks;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('monaco-editor/'))
      return { url: `file:///inline-fixture/${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.includes('/inline-fixture/'))
      return {
        format: 'module',
        shortCircuit: true,
        source: url.endsWith('editor.api.js')
          ? 'export const {editor, languages, Range} = globalThis.inlineFixture;'
          : url.endsWith('worker.start.js')
            ? 'export function start(factory) {globalThis.inlineFixture.workerStarted = factory();}'
            : '',
      };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const fixture = {
  Range,
  workerStarted: undefined as unknown,
  languages: { getLanguages: () => [{ id: 'typescript', extensions: ['.ts'] }] },
  editor: {
    create: (_root: HTMLElement, value: Record<string, unknown>) => {
      assert.equal(value.readOnly, true);
      return instance;
    },
    defineTheme: (_name: string, value: Record<string, unknown>) => {
      theme = value;
    },
    setTheme: (_name: string) => {},
    setModelLanguage: (_model: unknown, value: string) => {
      language = value;
    },
  },
};
class WorkerFixture {
  constructor(readonly url: string) {}
}
before(async () => {
  Object.defineProperty(root, 'clientHeight', { value: 500 });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    MutationObserver: dom.window.MutationObserver,
    inlineFixture: fixture,
    Worker: WorkerFixture,
    fetch: async () => ({ ok: true, text: async () => 'self.onmessage = () => {};' }),
    acquireVsCodeApi: () => ({
      postMessage: (message: Record<string, unknown>) => messages.push(message),
    }),
  });
  await import(new URL('../../media/inline-review.js', import.meta.url).href);
  assert.deepEqual(messages[0], { type: 'ready' });
  events.get('cursor')!({ position: { lineNumber: 1 } });
});
after(() => {
  dom.window.dispatchEvent(new dom.window.Event('unload'));
  hooks.deregister();
  dom.window.close();
  assert.equal(disposed, 2);
});

function render(overrides: Record<string, unknown> = {}) {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: {
        type: 'inlineReview',
        changeId: 'owned',
        revision: 'current',
        pending: true,
        available: true,
        editable: true,
        edited: false,
        text: 'HEADER:\r\ncontext\r\nFOOTER:\r\n',
        extension: '.ts',
        parts: [
          {
            kind: 'removed',
            line: 1,
            originalLine: 1,
            count: 1,
            text: 'Header:\r\n',
            hunkId: 'header',
          },
          { kind: 'added', line: 1, count: 1, text: 'HEADER:\r\n', hunkId: 'header' },
          {
            kind: 'removed',
            line: 3,
            originalLine: 3,
            count: 1,
            text: 'Footer:\r\n',
            hunkId: 'footer',
          },
          { kind: 'added', line: 3, count: 1, text: 'FOOTER:\r\n', hunkId: 'footer' },
        ],
        hunks: [
          { id: 'header', line: 1 },
          { id: 'footer', line: 3 },
        ],
        ...overrides,
      },
    }),
  );
}
const button = (name: string, action: string) =>
  root.querySelector<HTMLButtonElement>(
    `[data-hunk-id="${name}"] [aria-label="${action} change"]`,
  )!;

test('full-file inline rendering and floating controls preserve exact text and hunk identities', () => {
  render({ line: 3 });
  assert.equal(model.text, 'HEADER:\r\ncontext\r\nFOOTER:\r\n');
  assert.equal(language, 'typescript');
  assert.equal(zones.size, 4);
  assert.deepEqual(
    [...zones.values()].filter((zone) => zone.heightInPx).map((zone) => zone.afterLineNumber),
    [1, 3],
  );
  assert.equal(additions.length, 2);
  const overview = dom.window.document.getElementById('overview')!;
  assert.equal(overview.querySelectorAll('.overview-marker.added').length, 2);
  assert.equal(overview.querySelectorAll('.overview-marker.removed').length, 2);
  assert.ok(overview.querySelector('.overview-thumb'));
  assert.equal(revealed, 3);
  button('header', 'Keep').click();
  assert.deepEqual(messages.at(-1), {
    type: 'reviewAction',
    changeId: 'owned',
    revision: 'current',
    hunkId: 'header',
    operation: 'keep',
  });
  assert.ok([...root.querySelectorAll<HTMLButtonElement>('button')].every((item) => item.disabled));
  render({ available: false });
  const length = messages.length;
  button('footer', 'Undo').click();
  assert.equal(messages.length, length);
  render({ revision: 'refreshed' });
  button('footer', 'Undo').click();
  assert.equal(messages.at(-1)!.revision, 'refreshed');
  assert.equal(messages.at(-1)!.hunkId, 'footer');
  events.get('cursor')!({ position: { lineNumber: 3 } });
  assert.equal(messages.at(-1)!.type, 'cursor');
  render({ pending: false, parts: [], hunks: [], problem: 'File changed outside OMP.' });
  assert.equal(zones.size, 0);
  assert.equal(widgets.size, 0);
  assert.equal(
    dom.window.document.getElementById('status')!.textContent,
    'File changed outside OMP.',
  );
});

test('inline deleted text is escaped; file fallbacks, EOF and scroll positions remain reachable', () => {
  render({
    text: 'same',
    hunks: [],
    parts: [
      { kind: 'removed', line: 2, originalLine: 2, count: 1, text: '<img src=x onerror=alert(1)>' },
    ],
    language: 'plaintext',
  });
  assert.equal(language, 'plaintext');
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('.review-old-code')!.textContent, '<img src=x onerror=alert(1)>');
  const controls = root.querySelector<HTMLElement>('.review-controls')!;
  assert.equal(controls.style.top, '62px');
  scroll = 1000;
  events.get('scroll')!({});
  assert.equal(controls.hidden, true);
  scroll = -1000;
  events.get('layout')!({});
  assert.equal(controls.hidden, true);
  scroll = 0;
  events.get('scroll')!({});
  assert.equal(controls.hidden, false);
  root.querySelector<HTMLButtonElement>('button')!.click();
  assert.equal(messages.at(-1)!.hunkId, undefined);
  render({ text: '', parts: [], hunks: [], extension: '.unknown' });
  assert.equal(language, 'plaintext');
  assert.equal(widgets.size, 1);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'unrelated' } }));
});

test('editable proposals show whole-file actions and send exact edited text', () => {
  render();
  model.text = 'HEADER:\r\ncontext\r\nFOOTER:\r\n// edited';
  events.get('content')!({});
  const toolbar = dom.window.document.getElementById('toolbar')!;
  assert.equal(toolbar.hidden, false);
  assert.ok(
    [...root.querySelectorAll<HTMLElement>('.review-controls')].every((item) => item.hidden),
  );
  dom.window.document.querySelector<HTMLButtonElement>('[data-action="keepFile"]')!.click();
  assert.deepEqual(messages.at(-1), {
    type: 'reviewAction',
    changeId: 'owned',
    revision: 'current',
    operation: 'keep',
    text: 'HEADER:\r\ncontext\r\nFOOTER:\r\n// edited',
  });
  render({ edited: true, text: 'HEADER:\r\ncontext\r\nFOOTER:\r\n// edited' });
  dom.window.document.querySelector<HTMLButtonElement>('[data-action="resetFile"]')!.click();
  assert.deepEqual(messages.at(-1), { type: 'reset', changeId: 'owned', revision: 'current' });
  render({ edited: false, text: 'HEADER:\r\ncontext\r\nFOOTER:\r\n' });
  assert.equal(model.text, 'HEADER:\r\ncontext\r\nFOOTER:\r\n');
  assert.equal(toolbar.hidden, true);
});

test('overview pointer and wheel navigation delegate to the editor scroll position', () => {
  render();
  const overview = dom.window.document.getElementById('overview')!;
  contentHeight = 1000;
  scroll = 0;
  Object.defineProperty(overview, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0, left: 0, right: 10, bottom: 500, width: 10, height: 500 }),
  });
  overview.dispatchEvent(
    new dom.window.MouseEvent('pointerdown', { clientY: 250, button: 0, bubbles: true }),
  );
  assert.equal(scroll, 250);
  overview.dispatchEvent(
    new dom.window.MouseEvent('pointerup', { clientY: 250, button: 0, bubbles: true }),
  );
  scroll = 250;
  overview.dispatchEvent(
    new dom.window.WheelEvent('wheel', { deltaY: 200, cancelable: true, bubbles: true }),
  );
  assert.equal(scroll, 450);
  contentHeight = 500;
});

test('inline themes follow editor tokens and workers use only the owned local bundle', async () => {
  dom.window.document.body.classList.add('vscode-light');
  dom.window.document.body.style.setProperty('--vscode-editor-background', '#ffffff');
  dom.window.document.body.style.setProperty('--vscode-editor-foreground', '#111111');
  dom.window.document.body.style.setProperty('--vscode-editor-font-family', 'Test Mono');
  dom.window.document.body.style.setProperty('--vscode-editor-font-size', '15px');
  await Promise.resolve();
  assert.equal(theme.base, 'vs');
  const colors = theme.colors as Record<string, string>;
  assert.equal(colors['editor.background'], '#ffffff');
  assert.equal(colors['editor.foreground'], '#111111');
  assert.deepEqual(options, {
    fontFamily: 'Test Mono',
    fontSize: 15,
    wordWrap: 'on',
    wrappingIndent: 'same',
  });
  const environment = (
    globalThis as unknown as { MonacoEnvironment: { getWorker: () => Promise<WorkerFixture> } }
  ).MonacoEnvironment;
  const first = await environment.getWorker();
  const second = await environment.getWorker();
  assert.ok(first.url.startsWith('blob:'));
  assert.equal(first.url, second.url);
  await import(new URL('../../media/inline-worker.js', import.meta.url).href);
  assert.equal(fixture.workerStarted, null);
});
