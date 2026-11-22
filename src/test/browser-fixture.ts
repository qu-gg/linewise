import type { TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { installNativeBrowser } from '../native-browser.js';
import type { NativeEditApi } from '../native-edit.js';

export function nativeBrowserTool() {
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  installNativeBrowser({
    registerTool: (definition) => {
      tool = definition;
    },
  });
  return tool;
}

function browserDocument(context: TestContext) {
  const dom = new JSDOM(
    '<body><h1>Untrusted fixture</h1><script>NEVER_SCRIPT_TEXT</script><button id="exact">Choose</button><input id="password" type="password" value="NEVER_PASSWORD_VALUE"><select><option>One</option></select></body>',
  );
  const descriptors = new Map(
    ['document', 'NodeFilter', 'CSS'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  Object.assign(globalThis, {
    document: dom.window.document,
    NodeFilter: dom.window.NodeFilter,
    CSS: { escape: (text: string) => text },
  });
  context.after(() => {
    dom.window.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return dom;
}

function fakePage(state: { image: Buffer; actions: string[] }) {
  let url = 'about:blank';
  let closed = false;
  const listeners = new Map<string, (...args: never[]) => void>();
  const current = {
    url: () => url,
    title: async () => 'Fixture',
    isClosed: () => closed,
    on: (event: string, handler: (...args: never[]) => void) => listeners.set(event, handler),
    close: async () => {
      closed = true;
      listeners.get('close')?.();
    },
    goto: async (target: string) => {
      if (target.endsWith('/fail')) throw new Error('Navigation failure');
      url = target;
    },
    evaluate: async (callback: () => unknown) => callback(),
    screenshot: async () => state.image,
    goBack: async () => {
      state.actions.push('back');
    },
    goForward: async () => {
      state.actions.push('forward');
    },
    reload: async () => {
      state.actions.push('reload');
    },
    setViewportSize: async () => {
      state.actions.push('viewport');
    },
    locator: (selector: string) => ({
      count: async () => (selector === '.ambiguous' ? 2 : 1),
      getAttribute: async () => (selector === '#password' ? 'password' : ''),
      click: async () => {
        state.actions.push('click');
      },
      hover: async () => {
        state.actions.push('hover');
      },
      fill: async () => {
        state.actions.push('fill');
      },
      press: async () => {
        state.actions.push('press');
      },
      selectOption: async () => {
        state.actions.push('select');
      },
    }),
    emit: (event: string, value: unknown) => listeners.get(event)?.(value as never),
  };
  return current;
}

export function engine(context: TestContext) {
  const dom = browserDocument(context);
  const state = {
    closed: false,
    image: Buffer.from('unit image'),
    actions: [] as string[],
    routes: [] as Array<(route: unknown) => Promise<void>>,
    pages: [] as ReturnType<typeof fakePage>[],
  };
  const fakeContext = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async (_pattern: string, callback: (route: unknown) => Promise<void>) => {
      state.routes.push(callback);
    },
    newPage: async () => {
      const current = fakePage(state);
      state.pages.push(current);
      return current;
    },
  };
  context.mock.method(
    chromium,
    'launch',
    async () =>
      ({
        newContext: async () => fakeContext,
        close: async () => {
          state.closed = true;
          for (const current of state.pages) await current.close();
        },
      }) as unknown as Browser,
  );
  return { dom, state };
}
