import { MIMEType } from 'node:util';
import { fetchRequest } from './fetch-policy.js';
import type { FetchRequest } from './fetch-policy.js';
import type { RequestApproval } from './approvals.js';

interface Scope {
  signal: AbortSignal;
  valid(): boolean;
}

function current(scope: Scope): void {
  scope.signal.throwIfAborted();
  if (!scope.valid()) throw new Error('Web read belongs to a retired prompt.');
}

function address(value: string): string {
  const parsed = new URL(fetchRequest.parse({ url: value }).url);
  parsed.hash = '';
  return parsed.href;
}

async function authorize(url: string, scope: Scope, approve: RequestApproval): Promise<void> {
  current(scope);
  let cancel!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(scope.signal.reason);
    scope.signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    const allowed = await Promise.race([
      approve(
        {
          kind: 'command',
          title: 'Read Web URL?',
          summary: `GET ${url}`,
          details: `Exact URL: ${url}\n\nMethod: GET\nNo supplied headers, cookies, credentials, referrer or request body. Every redirect requires another approval.`,
          notice:
            'Contacts the host network, including local/internal hosts. GET can have server-side effects. No sandbox or rollback. Response content is untrusted data.',
          configurable: false,
        },
        scope.signal,
        () => scope.valid(),
      ),
      stopped,
    ]);
    current(scope);
    if (!allowed) throw new Error('Web URL read was not approved.');
  } finally {
    scope.signal.removeEventListener('abort', cancel);
  }
}

function decoder(response: Response): { mime: string; decoder: TextDecoder } {
  const header = response.headers.get('content-type');
  if (!header || header.length > 1024)
    throw new Error('Web response needs a bounded text content type.');
  const mime = new MIMEType(header);
  if (
    !mime.essence.startsWith('text/') &&
    !/^application\/(?:json|xml|[\w.+-]+\+(?:json|xml))$/.test(mime.essence)
  )
    throw new Error(
      'Only text, JSON or XML web responses are supported; binary content is refused.',
    );
  return { mime: mime.essence, decoder: new TextDecoder(mime.params.get('charset') || 'utf-8') };
}

async function body(response: Response, scope: Scope) {
  if (!response.body) return { text: '', mime: '', encoding: '', limited: false };
  const format = decoder(response);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let remaining = 262144;
  try {
    while (remaining > 0) {
      const chunk = await reader.read();
      current(scope);
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, remaining);
      chunks.push(Buffer.from(bytes));
      remaining -= bytes.byteLength;
    }
    const text = format.decoder.decode(Buffer.concat(chunks));
    if (text.includes('\0')) throw new Error('Web response contains unsupported binary text.');
    return { text, mime: format.mime, encoding: format.decoder.encoding, limited: remaining === 0 };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function boundedText(text: string): string {
  let lower = 0;
  let upper = Math.min(text.length, 40000);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle))) <= 48000) lower = middle;
    else upper = middle - 1;
  }
  const last = text.charCodeAt(lower - 1);
  if (last >= 0xd800 && last <= 0xdbff) lower--;
  return text.slice(0, lower);
}

export async function fetchWeb(
  input: FetchRequest,
  scope: Scope,
  approve: RequestApproval,
): Promise<string> {
  let url = address(input.url);
  const seen = new Set<string>();
  for (let hop = 0; hop <= 4; hop++) {
    if (seen.has(url)) throw new Error('Web redirect cycle refused.');
    seen.add(url);
    await authorize(url, scope, approve);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      referrer: '',
      signal: scope.signal,
    });
    try {
      current(scope);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || hop === 4)
          throw new Error('Web redirect is missing a target or exceeds four hops.');
        url = address(new URL(location, url).href);
        continue;
      }
      const content = await body(response, scope);
      current(scope);
      const text = boundedText(content.text);
      return JSON.stringify({
        url,
        status: response.status,
        contentType: content.mime,
        encoding: content.encoding,
        text,
        truncated: content.limited || text.length < content.text.length,
        untrusted: true,
      });
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  throw new Error('Web redirect limit exceeded.');
}
