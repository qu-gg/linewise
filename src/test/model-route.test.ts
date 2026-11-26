import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  ModelRoutes,
  routeEligible,
  routePresentation,
  emptyRouteCatalog,
} from '../model-route.js';
import type { RouteOption } from '../model-routes.js';
import type { SavedSession } from '../state.js';

const model = 'openrouter/deepseek/deepseek-v4.1-flash-1017';
const providers: RouteOption[] = [
  { value: 'baseten', name: 'BaseTen', description: 'baseten' },
  { value: 'nebius', name: 'Nebius', description: 'nebius/fp4' },
];
const turn = {
  id: 'turn',
  prompt: 'Prompt',
  status: 'completed' as const,
  startedAt: 1,
  endedAt: 2,
  blocks: [],
};
const modelConfig: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  type: 'select',
  currentValue: model,
  options: [],
};

function session(overrides: Partial<SavedSession> = {}): SavedSession {
  return { id: 'session', root: 'file:///workspace', label: 'Workspace', turns: [], ...overrides };
}

function controller(request: () => Promise<RouteOption[]> = async () => providers) {
  let active: SavedSession | undefined = session();
  let changes = 0;
  let published = 0;
  const client = { configOptions: [modelConfig] };
  const routes = new ModelRoutes(
    request,
    () => published++,
    () => client,
    () => active,
    () => changes,
  );
  return {
    routes,
    setActive: (value: SavedSession | undefined) => (active = value),
    setChanges: (value: number) => (changes = value),
    published: () => published,
  };
}

test('route eligibility requires a new OpenRouter session without changes', () => {
  assert.equal(routeEligible(undefined, model, 0), false);
  assert.equal(routeEligible(session(), model, 0), true);
  assert.equal(routeEligible(session({ turns: [turn] }), model, 0), false);
  assert.equal(routeEligible(session(), model, 1), false);
  assert.equal(routeEligible(session(), 'anthropic/claude', 0), false);
  assert.equal(routeEligible(session(), 'openrouter/~deepseek/flash', 0), false);
});

test('route presentation defaults to Auto and exposes loaded providers', () => {
  const hidden = routePresentation(undefined, model, emptyRouteCatalog(), undefined, 0);
  assert.equal(hidden.visible, false);
  assert.deepEqual(hidden.options, []);
  const presentation = routePresentation(
    session(),
    model,
    { model, loading: false, error: '', options: providers },
    undefined,
    0,
  );
  assert.equal(presentation.visible, true);
  assert.equal(presentation.value, 'auto');
  assert.deepEqual(
    presentation.options.map((option) => option.value),
    ['auto', 'baseten', 'nebius'],
  );
  assert.equal(
    routePresentation(
      session(),
      model,
      { model, loading: false, error: 'offline', options: providers },
      undefined,
      0,
    ).visible,
    false,
  );
});

test('controller loads, selects, verifies, and clears a pending route', async () => {
  const { routes, published } = controller();
  await routes.refresh();
  assert.deepEqual(
    routes.catalog.options.map((option) => option.value),
    ['baseten', 'nebius'],
  );
  assert.equal(routes.presentation().visible, true);
  assert.ok(published() >= 2);

  routes.select('baseten');
  assert.equal(routes.presentation().value, 'baseten');
  const launch = routes.pendingLaunch();
  assert.ok(launch);
  assert.equal(launch.selector, `${model}@baseten`);
  assert.equal(launch.provider, 'baseten');
  assert.equal(launch.label, 'BaseTen');
  assert.equal(launch.replace.turns.length, 0);
  assert.equal(routes.verifyLaunch(launch.selector), model);
  assert.throws(
    () => routes.verifyLaunch('openrouter/qwen/qwen3.8-flash@baseten'),
    /did not start/,
  );
  routes.clearPending();
  assert.equal(routes.pendingLaunch(), undefined);

  routes.select('auto');
  assert.equal(routes.presentation().value, 'auto');
  assert.throws(() => routes.select('missing'), /current route/);
});

test('controller refuses provider changes after turns or with pending changes', async () => {
  const { routes, setActive, setChanges } = controller();
  await routes.refresh();
  setActive(session({ turns: [turn] }));
  assert.equal(routes.presentation().visible, false);
  assert.throws(() => routes.select('baseten'), /new chat/);
  setActive(session());
  setChanges(1);
  assert.equal(routes.presentation().visible, false);
  assert.throws(() => routes.select('baseten'), /new chat/);
});

test('controller keeps known providers on refresh failure and clears on generation change', async () => {
  let fail = false;
  const { routes } = controller(async () => {
    if (fail) throw new Error('offline');
    return providers;
  });
  await routes.refresh();
  fail = true;
  await routes.refresh();
  assert.equal(routes.catalog.error, '');
  assert.deepEqual(
    routes.catalog.options.map((option) => option.value),
    ['baseten', 'nebius'],
  );

  const failed = controller(async () => {
    throw new Error('offline');
  });
  await failed.routes.refresh();
  assert.match(failed.routes.catalog.error, /offline/);
  assert.equal(failed.routes.presentation().visible, false);

  const deferred = Promise.withResolvers<RouteOption[]>();
  const pending = controller(() => deferred.promise);
  const loading = pending.routes.refresh();
  pending.routes.clear();
  deferred.resolve(providers);
  await loading;
  assert.deepEqual(pending.routes.catalog.options, []);
});
