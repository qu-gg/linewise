import assert from 'node:assert/strict';

function requestApi(url, origins) {
  assert.ok(origins.includes(url.origin), 'Unapproved live inference origin.');
  assert.ok(!url.username && !url.password, 'Live inference URL credentials are refused.');
  if (url.pathname.endsWith('/chat/completions')) return 'openai-completions';
  if (url.pathname.endsWith('/responses')) return 'openai-responses';
  throw new Error('Unsupported live inference endpoint.');
}

async function requestPayload(request) {
  assert.ok(!request.headers.has('content-encoding'), 'Encoded live inference is unsupported.');
  assert.ok(request.body, 'Live inference requires a bounded JSON body.');
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel(request.signal.reason);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= 1_048_576, 'Live inference body exceeds 1 MiB.');
      chunks.push(Buffer.from(chunk.value));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Invalid live inference JSON.');
    }
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    return payload;
  } finally {
    request.signal.removeEventListener('abort', abort);
    await reader.cancel();
    reader.releaseLock();
  }
}

function cappedPayload(payload, api, model, tokens) {
  assert.ok(payload.model === model, 'Live inference model identity refused.');
  assert.ok(Number.isInteger(tokens) && tokens > 0 && tokens <= 4096);
  const fields =
    api === 'openai-responses' ? ['max_output_tokens'] : ['max_tokens', 'max_completion_tokens'];
  let cap = tokens;
  for (const field of fields) {
    if (payload[field] === undefined) continue;
    assert.ok(Number.isInteger(payload[field]) && payload[field] > 0, 'Invalid output cap.');
    cap = Math.min(cap, payload[field]);
    delete payload[field];
  }
  const field = api === 'openai-responses' ? 'max_output_tokens' : 'max_completion_tokens';
  return { payload: { ...payload, [field]: cap }, cap };
}

export function boundedFetch(fetchImpl, policy) {
  assert.equal(typeof fetchImpl, 'function');
  assert.equal(typeof policy.authorize, 'function');
  return async (input, init) => {
    const original = new Request(input, init);
    assert.equal(original.method, 'POST', 'Unsupported live inference method.');
    const deadline = policy.signal?.();
    const request = deadline
      ? new Request(original, { signal: AbortSignal.any([original.signal, deadline]) })
      : original;
    const url = new URL(request.url);
    const api = requestApi(url, policy.origins);
    const body = await requestPayload(request);
    const { payload, cap } = cappedPayload(body, api, policy.model, policy.tokens);
    request.signal.throwIfAborted();
    await policy.authorize({ model: policy.model, api, maxOutputTokens: cap });
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return fetchImpl(request.url, {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: request.signal,
      redirect: 'manual',
    });
  };
}

function transportWindow(report, wrapped) {
  return (
    globalThis.fetch === wrapped && Date.now() < report.startedAt + report.limits.runSeconds * 1000
  );
}

async function refuseTransport(report, save) {
  const reason = 'Live transport request or time budget refused.';
  report.refused.push(reason);
  await save();
  throw new Error(reason);
}

export function installLiveTransport(report, save) {
  if (report.limits.transport !== 'http') return;
  const original = globalThis.fetch;
  const wrapped = boundedFetch(original, {
    origins: [
      'https://api.githubcopilot.com',
      'https://api.individual.githubcopilot.com',
      'https://api.business.githubcopilot.com',
      'https://api.enterprise.githubcopilot.com',
    ],
    model: report.limits.model.split('/')[1],
    tokens: report.limits.tokens,
    signal: () =>
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            report.limits.seconds * 1000,
            report.startedAt + report.limits.runSeconds * 1000 - Date.now(),
          ),
        ),
      ),
    authorize: async (metadata) => {
      if (!transportWindow(report, wrapped) || report.requests.length >= report.limits.requests)
        await refuseTransport(report, save);
      report.requests.push({
        ...metadata,
        model: report.limits.model,
        at: Date.now(),
        source: 'http-transport',
      });
      await save();
      if (!transportWindow(report, wrapped)) await refuseTransport(report, save);
    },
  });
  globalThis.fetch = wrapped;
  return {
    active: () => globalThis.fetch === wrapped,
    restore: () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    },
  };
}
