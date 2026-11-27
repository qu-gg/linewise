import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { browserRequest } from './browser-policy.js';
import type { BrowserRequest } from './browser-policy.js';

type LaunchOptions = Parameters<typeof chromium.launch>[0];
type Launch = (options: LaunchOptions) => Promise<Browser>;

export interface BrowserOptions {
  signal: AbortSignal;
  executablePath?: string;
  headless?: boolean;
  launch?: Launch;
  exists?: (target: string) => boolean;
  approve(request: BrowserRequest, signal: AbortSignal): Promise<boolean>;
}

const SYSTEM_BROWSERS = [
  process.env.CHROME_PATH,
  process.env.BRAVE_PATH,
  '/usr/bin/brave-browser',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter((candidate): candidate is string => Boolean(candidate));

function missingExecutable(error: unknown): boolean {
  return error instanceof Error && /executable doesn't exist|enoent/i.test(error.message);
}

function unavailable(error: unknown, executable?: string): Error {
  const target = executable ? ` at ${executable}` : '';
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `No usable Chromium executable${target} for OMP-owned Playwright pages. ` +
      'Set omp.browser.executablePath to an absolute Chromium, Chrome or Brave path, ' +
      `or install Playwright Chromium with "npx playwright-core install chromium-headless-shell". ${detail}`,
    { cause: error },
  );
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    function pageText() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let text = '';
      let scanned = 0;
      while (walker.nextNode() && scanned++ < 4000 && text.length < 40000) {
        const parent = walker.currentNode.parentElement;
        if (parent?.closest('script,style,noscript,template,[hidden]')) continue;
        const value = walker.currentNode.textContent?.trim();
        if (value) text += `${value}\n`;
      }
      return { text: text.slice(0, 40000), limited: scanned >= 4000 || text.length >= 40000 };
    }
    function control(element: Element, index: number) {
      const id = element.id && element.id.length <= 100 ? `#${CSS.escape(element.id)}` : undefined;
      return {
        selector: id || `:is(a,button,input,select,textarea,[role]) >> nth=${index}`,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role')?.slice(0, 80),
        type: element.getAttribute('type')?.slice(0, 80),
        label: (element.getAttribute('aria-label') || element.textContent || '').slice(0, 200),
      };
    }
    const text = pageText();
    const controls = [];
    for (const element of document.querySelectorAll('a,button,input,select,textarea,[role]')) {
      if (controls.length >= 100) break;
      controls.push(control(element, controls.length));
    }
    return {
      text: text.text,
      controls,
      limited: text.limited || controls.length >= 100,
    };
  });
}

async function interact(page: Page, input: BrowserRequest): Promise<void> {
  if (!('selector' in input)) throw new Error('Unsupported browser interaction.');
  const locator = page.locator(input.selector);
  if ((await locator.count()) !== 1) throw new Error('Selector must match exactly one element.');
  if ((await locator.getAttribute('type')) === 'password')
    throw new Error('Password fields are not exposed to browser tools.');
  switch (input.action) {
    case 'click':
      await locator.click();
      break;
    case 'hover':
      await locator.hover();
      break;
    case 'fill':
      await locator.fill(input.text);
      break;
    case 'press':
      await locator.press(input.key);
      break;
    case 'select':
      await locator.selectOption(input.values);
      break;
  }
}

export class OwnedBrowser {
  private context?: BrowserContext;
  private launching?: Promise<Browser>;
  private readonly pages = new Map<string, Page>();
  private readonly messages = new Map<string, string[]>();
  private disposed = false;
  private busy = false;
  private closing?: Promise<void>;

  constructor(private readonly options: BrowserOptions) {}

  private assertCurrent(): void {
    this.options.signal.throwIfAborted();
    if (this.disposed) throw new Error('Owned browser has closed.');
  }

  private async launch(): Promise<Browser> {
    const launch = this.options.launch ?? chromium.launch.bind(chromium);
    const headless = this.options.headless ?? true;
    const executable = this.options.executablePath;
    try {
      return await launch({ executablePath: executable, headless });
    } catch (error) {
      if (!missingExecutable(error)) throw error;
      if (executable) throw unavailable(error, executable);
      const fallback = SYSTEM_BROWSERS.find(this.options.exists ?? existsSync);
      if (!fallback) throw unavailable(error);
      try {
        return await launch({ executablePath: fallback, headless });
      } catch (failure) {
        throw unavailable(failure, fallback);
      }
    }
  }

  private async start(): Promise<BrowserContext> {
    this.assertCurrent();
    if (this.context) return this.context;
    this.launching ??= this.launch();
    const browser = await this.launching;
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1100, height: 800 },
    });
    context.setDefaultTimeout(0);
    context.setDefaultNavigationTimeout(0);
    await context.route('**/*', async (route) => {
      const parsed = browserRequest.safeParse({ action: 'open', url: route.request().url() });
      if (parsed.success) await route.continue();
      else await route.abort();
    });
    this.assertCurrent();
    this.context = context;
    return context;
  }

  private page(id: string): Page {
    const page = this.pages.get(id);
    if (!page || page.isClosed())
      throw new Error('No open page belongs to this session owner and pageId.');
    return page;
  }

  currentUrl(): string | undefined {
    for (const page of [...this.pages.values()].reverse()) if (!page.isClosed()) return page.url();
  }

  private async open(url: string): Promise<string> {
    if (this.pages.size >= 4) throw new Error('At most four owned pages are allowed.');
    const context = await this.start();
    const page = await context.newPage();
    const pageId = randomUUID();
    const messages: string[] = [];
    const record = (text: string) => {
      messages.push(text.slice(0, 500));
      if (messages.length > 64) messages.shift();
    };
    this.pages.set(pageId, page);
    this.messages.set(pageId, messages);
    page.on('console', (message) => record(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => record(`error: ${error.message}`));
    page.on('requestfailed', (request) => record(`request failed: ${request.url()}`));
    page.on('popup', (popup) => {
      void popup.close().catch(() => {});
    });
    page.on('download', (download) => {
      void download.cancel().catch(() => {});
    });
    page.on('close', () => {
      this.pages.delete(pageId);
      this.messages.delete(pageId);
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return JSON.stringify({
        pageId,
        url: page.url(),
        title: (await page.title()).slice(0, 1000),
        untrusted: true,
      });
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  private async inspect(page: Page, input: BrowserRequest): Promise<unknown> {
    if (input.action === 'read') return { ...(await snapshot(page)), untrusted: true };
    if (input.action === 'console')
      return { messages: this.messages.get(input.pageId), untrusted: true };
    if (input.action === 'screenshot') {
      const image = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
      if (image.length > 512 * 1024)
        throw new Error('Screenshot exceeds 512 KiB; use a smaller viewport.');
      return { data: image.toString('base64'), mimeType: 'image/png', untrusted: true };
    }
    await this.change(page, input);
    return {
      pageId: 'pageId' in input ? input.pageId : undefined,
      url: page.url(),
      untrusted: true,
    };
  }

  private async change(page: Page, input: BrowserRequest): Promise<void> {
    switch (input.action) {
      case 'navigate':
        await page.goto(input.url, { waitUntil: 'domcontentloaded' });
        break;
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded' });
        break;
      case 'forward':
        await page.goForward({ waitUntil: 'domcontentloaded' });
        break;
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' });
        break;
      case 'close':
        await page.close();
        break;
      case 'viewport':
        await page.setViewportSize({ width: input.width, height: input.height });
        break;
      default:
        await interact(page, input);
    }
  }

  async execute(
    value: unknown,
    operation: Pick<BrowserOptions, 'signal' | 'approve'> = this.options,
  ): Promise<string> {
    const input = browserRequest.parse(value);
    const signal = AbortSignal.any([this.options.signal, operation.signal]);
    signal.throwIfAborted();
    this.assertCurrent();
    if (this.busy) throw new Error('Another owned-browser action is still pending.');
    this.busy = true;
    const abort = () => {
      void this.dispose().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (input.action === 'pages')
        return JSON.stringify({
          pages: [...this.pages].map(([pageId, page]) => ({ pageId, url: page.url() })),
          ownedOnly: true,
        });
      const page = input.action === 'open' ? undefined : this.page(input.pageId);
      if (
        !['read', 'console', 'screenshot', 'close'].includes(input.action) &&
        !(await operation.approve(input, signal))
      )
        throw new Error('Owned-browser action was not approved.');
      signal.throwIfAborted();
      this.assertCurrent();
      const result =
        input.action === 'open'
          ? await this.open(input.url)
          : JSON.stringify(await this.inspect(page!, input));
      signal.throwIfAborted();
      this.assertCurrent();
      return result;
    } finally {
      this.busy = false;
      signal.removeEventListener('abort', abort);
    }
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.closing ??= (async () => {
      const browser = await this.launching?.catch(() => undefined);
      await browser?.close();
      this.pages.clear();
      this.messages.clear();
    })();
    return this.closing;
  }
}

export class SessionBrowser {
  private current?: { owner: string; abort: AbortController; browser: OwnedBrowser };
  private closing?: Promise<void>;
  private busy = false;

  currentUrl(): string | undefined {
    return this.current?.browser.currentUrl();
  }
  async bind(owner: string): Promise<void> {
    await this.closing;
    if (this.current && this.current.owner !== owner) await this.revoke();
  }

  async execute(owner: string, value: unknown, options: BrowserOptions): Promise<string> {
    if (this.busy) throw new Error('Another owned-browser action is still pending.');
    this.busy = true;
    try {
      await this.bind(owner);
      options.signal.throwIfAborted();
      if (!this.current) {
        const abort = new AbortController();
        this.current = {
          owner,
          abort,
          browser: new OwnedBrowser({
            signal: abort.signal,
            executablePath: options.executablePath,
            headless: options.headless,
            approve: async () => false,
          }),
        };
      }
      return await this.current.browser.execute(value, options);
    } catch (error) {
      if (options.signal.aborted) await this.revoke();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  revoke(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    current?.abort.abort();
    this.closing = Promise.all([this.closing, current?.browser.dispose()]).then(() => {});
    return this.closing;
  }
}
