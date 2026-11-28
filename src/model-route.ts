import type { OmpClient } from './acp.js';
import { safeError } from './acp.js';
import {
  openRouterModel,
  optimalRoute,
  routeBaseModel,
  routeSelector,
  type OptimalRoute,
  type RouteOption,
} from './model-routes.js';
import type { SavedSession } from './state.js';

export interface PendingRoute {
  model: string;
  provider: string;
  label: string;
}

export interface RouteCatalog {
  model: string;
  loading: boolean;
  error: string;
  options: RouteOption[];
}

export interface RoutePresentation {
  visible: boolean;
  value: string;
  options: RouteOption[];
  loading: boolean;
  error: string;
}

export interface AppliedRoute {
  provider: string;
  label: string;
}

export interface LaunchRoute extends AppliedRoute {
  selector: string;
  replace: SavedSession;
}

type ModelClient = Pick<OmpClient, 'configOptions'>;

const AUTO_ROUTE = 'auto';
const OPTIMAL_ROUTE = 'optimal';
const NO_OPTIMAL = 'No provider reports both 30-minute throughput and completion price.';
const AUTO_OPTION: RouteOption = {
  value: AUTO_ROUTE,
  name: 'Auto (OpenRouter)',
  description: 'OpenRouter default routing',
};

function optimalDescription(route: OptimalRoute): string {
  const price = (route.completionPrice * 1_000_000).toFixed(2);
  return `${route.name} · ${route.throughput.toFixed(1)} tok/s · $${price}/M completion`.slice(
    0,
    200,
  );
}

function optimalOption(providers: readonly RouteOption[]): RouteOption {
  const optimal = optimalRoute(providers);
  if (optimal)
    return { value: OPTIMAL_ROUTE, name: 'Optimal', description: optimalDescription(optimal) };
  return { value: OPTIMAL_ROUTE, name: 'Optimal', description: NO_OPTIMAL, disabled: true };
}

function routeOptions(providers: RouteOption[] | undefined): RouteOption[] {
  if (!providers) return [AUTO_OPTION];
  return [AUTO_OPTION, optimalOption(providers), ...providers];
}

export function emptyRouteCatalog(): RouteCatalog {
  return { model: '', loading: false, error: '', options: [] };
}

export function routeEligible(
  session: SavedSession | undefined,
  model: string,
  changes: number,
): session is SavedSession {
  return Boolean(
    session &&
    session.turns.length === 0 &&
    !session.historyTransition &&
    openRouterModel(model) &&
    changes === 0,
  );
}

export function routePresentation(
  session: SavedSession | undefined,
  model: string,
  catalog: RouteCatalog,
  pending: PendingRoute | undefined,
  changes: number,
): RoutePresentation {
  if (!routeEligible(session, model, changes))
    return { visible: false, value: AUTO_ROUTE, options: [], loading: false, error: '' };
  const loaded = catalog.model === model;
  const providers = loaded ? catalog.options : undefined;
  const loading = loaded && catalog.loading;
  const error = loaded ? catalog.error : '';
  return {
    visible: !error && Boolean(providers?.length),
    value: pending?.model === model ? pending.provider : AUTO_ROUTE,
    options: routeOptions(providers),
    loading,
    error,
  };
}

export class ModelRoutes {
  catalog = emptyRouteCatalog();
  private pendingRoute: PendingRoute | undefined;
  private generation = 0;

  constructor(
    private readonly request: (model: string) => Promise<RouteOption[]>,
    private readonly publish: () => void,
    private readonly client: () => ModelClient | undefined,
    private readonly active: () => SavedSession | undefined,
    private readonly changes: (session: SavedSession) => number,
  ) {}

  clear(): void {
    this.generation++;
    this.catalog = emptyRouteCatalog();
    this.pendingRoute = undefined;
  }

  clearPending(): void {
    this.pendingRoute = undefined;
  }

  clearPendingFor(
    fresh: boolean,
    selected: SavedSession | undefined,
    launch: LaunchRoute | undefined,
  ): void {
    if (selected || (fresh && !launch)) this.pendingRoute = undefined;
  }

  modelChanged(): void {
    this.pendingRoute = undefined;
  }

  select(value: string): void {
    const model = this.model() ?? '';
    const session = this.active();
    if (!routeEligible(session, model, session ? this.changes(session) : 0))
      throw new Error('OpenRouter provider routing is only available for a new chat.');
    if (value === 'auto') {
      this.pendingRoute = undefined;
      return;
    }
    if (value === OPTIMAL_ROUTE) {
      if (!this.optimal())
        throw new Error(
          'Optimal routing is unavailable: OpenRouter returned no throughput and completion price.',
        );
      this.pendingRoute = { model, provider: OPTIMAL_ROUTE, label: 'Optimal' };
      return;
    }
    const option =
      this.catalog.model === model
        ? this.catalog.options.find((candidate) => candidate.value === value)
        : undefined;
    if (!option) throw new Error('Choose a provider from the current route list.');
    this.pendingRoute = { model, provider: option.value, label: option.name };
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const model = this.model() ?? '';
    const session = this.active();
    if (!routeEligible(session, model, session ? this.changes(session) : 0)) {
      this.catalog = { model, loading: false, error: '', options: [] };
      return;
    }
    const previous = this.catalog.model === model ? this.catalog.options : [];
    this.catalog = { model, loading: true, error: '', options: previous };
    this.publish();
    try {
      const options = await this.request(model);
      if (generation === this.generation)
        this.catalog = { model, loading: false, error: '', options };
    } catch (error) {
      if (generation === this.generation)
        this.catalog = {
          model,
          loading: false,
          error: previous.length ? '' : safeError(error),
          options: previous,
        };
    }
    this.publish();
  }

  presentation(): RoutePresentation {
    const session = this.active();
    return routePresentation(
      session,
      this.model() ?? '',
      this.catalog,
      this.pendingRoute,
      session ? this.changes(session) : 0,
    );
  }

  pendingLaunch(): LaunchRoute | undefined {
    const pending = this.pendingRoute;
    if (!pending) return undefined;
    const model = this.model() ?? '';
    const session = this.active();
    if (
      !routeEligible(session, model, session ? this.changes(session) : 0) ||
      pending.model !== model
    ) {
      this.pendingRoute = undefined;
      this.publish();
      return undefined;
    }
    if (pending.provider === OPTIMAL_ROUTE) {
      const optimal = this.optimal();
      if (!optimal)
        throw new Error(
          'Optimal routing is unavailable: OpenRouter returned no throughput and completion price. Choose Auto or a provider.',
        );
      return {
        selector: routeSelector(pending.model, optimal.provider),
        provider: optimal.provider,
        label: `Optimal · ${optimal.name}`,
        replace: session,
      };
    }
    return {
      selector: routeSelector(pending.model, pending.provider),
      provider: pending.provider,
      label: pending.label,
      replace: session,
    };
  }

  verifyLaunch(selector: string): string {
    const current = this.model();
    const model = routeBaseModel(selector);
    if (current !== model) throw new Error('OMP did not start on the selected OpenRouter model.');
    return model;
  }

  private optimal(): OptimalRoute | undefined {
    const model = this.model() ?? '';
    if (this.catalog.model !== model) return undefined;
    return optimalRoute(this.catalog.options);
  }

  private model(): string | undefined {
    const option = this.client()?.configOptions.find((candidate) => candidate.id === 'model');
    return typeof option?.currentValue === 'string' ? option.currentValue : undefined;
  }
}
