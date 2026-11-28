import { z } from 'zod';

export interface RouteOption {
  value: string;
  name: string;
  description?: string;
  disabled?: boolean;
  /** 30-minute p50 output tokens per second, when OpenRouter reports it. */
  throughput?: number;
  /** USD per completion token, when OpenRouter reports it. */
  completionPrice?: number;
}

/** Best eligible provider under the throughput-per-completion-dollar score. */
export interface OptimalRoute {
  provider: string;
  name: string;
  score: number;
  throughput: number;
  completionPrice: number;
}

const providerResponse = z.object({
  data: z.object({
    endpoints: z.array(z.unknown()).max(256),
  }),
});
const providerEndpoint = z.object({
  provider_name: z.string().optional(),
  tag: z.string(),
  status: z.number().optional(),
  throughput_last_30m: z.unknown().optional(),
  pricing: z.unknown().optional(),
});

const OPENROUTER_PREFIX = 'openrouter/';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const ROUTING_VARIANT = /:(?:free|batch|nitro|floor|online|exacto)$/;
const MODEL_PART = /^[A-Za-z0-9._-]+$/;
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

/** The canonical OpenRouter model behind an OMP `openrouter/...` selector. */
export function openRouterModel(selector: string): string | undefined {
  if (!selector.startsWith(OPENROUTER_PREFIX)) return undefined;
  let model = selector.slice(OPENROUTER_PREFIX.length);
  if (!model || model.startsWith('~') || model.includes('@')) return undefined;
  model = model.replace(ROUTING_VARIANT, '');
  const parts = model.split('/');
  if (parts.length !== 2 || !parts.every((part) => MODEL_PART.test(part))) return undefined;
  return model;
}

/** A routed model selector that OMP's startup resolver accepts for new sessions. */
export function routeSelector(model: string, provider: string): string {
  if (!openRouterModel(model)) throw new Error('Provider routing is unavailable for this model.');
  if (!PROVIDER_SLUG.test(provider)) throw new Error('Invalid OpenRouter provider.');
  return `${model}@${provider}`;
}

export function routeBaseModel(selector: string): string {
  const at = selector.indexOf('@');
  return at > 0 ? selector.slice(0, at) : selector;
}

export function routeProvider(selector: string): string | undefined {
  const at = selector.indexOf('@');
  return at > 0 ? selector.slice(at + 1) : undefined;
}

interface EndpointProvider {
  slug: string;
  name: string;
  tag: string;
  available: boolean;
  throughput?: number;
  completionPrice?: number;
}

interface ProviderGroup {
  name: string;
  tags: Set<string>;
  available: boolean;
  throughput?: number;
  completionPrice?: number;
  score?: number;
  tag?: string;
}

interface EndpointMetrics {
  throughput: number;
  completionPrice: number;
  score: number;
}

function providerName(raw: string | undefined, slug: string): string {
  return (
    (raw ?? slug)
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, 100) || slug
  );
}

function positiveMetric(raw: unknown): number | undefined {
  let value = raw;
  if (typeof value === 'string') {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())) return undefined;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function endpointThroughput(raw: unknown): number | undefined {
  if (raw && typeof raw === 'object' && 'p50' in raw)
    return positiveMetric((raw as { p50?: unknown }).p50);
  return positiveMetric(raw);
}

function endpointCompletionPrice(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return positiveMetric((raw as { completion?: unknown }).completion);
}

function endpointMetrics(endpoint: EndpointProvider): EndpointMetrics | undefined {
  if (
    !endpoint.available ||
    endpoint.throughput === undefined ||
    endpoint.completionPrice === undefined
  )
    return undefined;
  const score = endpoint.throughput / endpoint.completionPrice;
  if (!Number.isFinite(score)) return undefined;
  return { throughput: endpoint.throughput, completionPrice: endpoint.completionPrice, score };
}

function endpointProvider(raw: unknown): EndpointProvider | undefined {
  const endpoint = providerEndpoint.safeParse(raw);
  if (!endpoint.success) return undefined;
  const { tag, provider_name: name, status, throughput_last_30m, pricing } = endpoint.data;
  const slug = tag.split('/')[0]?.toLowerCase();
  if (!slug || !PROVIDER_SLUG.test(slug)) return undefined;
  const throughput = endpointThroughput(throughput_last_30m);
  const completionPrice = endpointCompletionPrice(pricing);
  return {
    slug,
    name: providerName(name, slug),
    tag,
    available: status === undefined || status >= 0,
    ...(throughput !== undefined ? { throughput } : {}),
    ...(completionPrice !== undefined ? { completionPrice } : {}),
  };
}

function providerOptions(providers: Map<string, ProviderGroup>): RouteOption[] {
  return [...providers.entries()]
    .map(([slug, provider]) => {
      const tags = [...provider.tags].sort().join(', ');
      const state = provider.available ? '' : 'unavailable';
      const description = [tags, state].filter(Boolean).join(' · ').slice(0, 200);
      return {
        value: slug,
        name: provider.name,
        ...(description ? { description } : {}),
        ...(provider.throughput !== undefined && provider.completionPrice !== undefined
          ? { throughput: provider.throughput, completionPrice: provider.completionPrice }
          : {}),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function betterEndpoint(candidate: EndpointMetrics, tag: string, current: ProviderGroup): boolean {
  if (current.score === undefined) return true;
  if (candidate.score !== current.score) return candidate.score > current.score;
  if (candidate.completionPrice !== current.completionPrice)
    return candidate.completionPrice < (current.completionPrice ?? Infinity);
  return tag < (current.tag ?? '');
}

/** Group OpenRouter's per-endpoint rows into one selectable option per provider slug. */
export function parseOpenRouterProviders(body: unknown): RouteOption[] {
  const parsed = providerResponse.safeParse(body);
  if (!parsed.success) throw new Error('Invalid OpenRouter provider list.');
  const providers = new Map<string, ProviderGroup>();
  for (const raw of parsed.data.data.endpoints) {
    const endpoint = endpointProvider(raw);
    if (!endpoint) continue;
    const metrics = endpointMetrics(endpoint);
    const current = providers.get(endpoint.slug);
    if (current) {
      current.tags.add(endpoint.tag);
      current.available ||= endpoint.available;
      if (metrics && betterEndpoint(metrics, endpoint.tag, current)) {
        current.throughput = metrics.throughput;
        current.completionPrice = metrics.completionPrice;
        current.score = metrics.score;
        current.tag = endpoint.tag;
      }
    } else {
      providers.set(endpoint.slug, {
        name: endpoint.name,
        tags: new Set([endpoint.tag]),
        available: endpoint.available,
        ...(metrics ?? {}),
        ...(metrics ? { tag: endpoint.tag } : {}),
      });
    }
  }
  return providerOptions(providers);
}

function betterOptimal(candidate: OptimalRoute, current: OptimalRoute): boolean {
  if (candidate.score !== current.score) return candidate.score > current.score;
  if (candidate.completionPrice !== current.completionPrice)
    return candidate.completionPrice < current.completionPrice;
  const name = candidate.name.localeCompare(current.name, undefined, { sensitivity: 'base' });
  if (name !== 0) return name < 0;
  return candidate.provider < current.provider;
}

/** Choose the eligible provider with the highest throughput per completion dollar. */
export function optimalRoute(options: readonly RouteOption[]): OptimalRoute | undefined {
  let best: OptimalRoute | undefined;
  for (const option of options) {
    if (option.disabled) continue;
    const throughput = positiveMetric(option.throughput);
    const completionPrice = positiveMetric(option.completionPrice);
    if (throughput === undefined || completionPrice === undefined) continue;
    const score = throughput / completionPrice;
    if (!Number.isFinite(score)) continue;
    const candidate = {
      provider: option.value,
      name: option.name,
      score,
      throughput,
      completionPrice,
    };
    if (!best || betterOptimal(candidate, best)) best = candidate;
  }
  return best;
}

export class OpenRouterRoutes {
  private readonly cache = new Map<string, { expiresAt: number; providers: RouteOption[] }>();

  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}

  async providers(selector: string): Promise<RouteOption[]> {
    const model = openRouterModel(selector);
    if (!model) throw new Error('Provider routing is unavailable for this model.');
    const cached = this.cache.get(model);
    if (cached && cached.expiresAt > this.now()) return cached.providers;
    const [author, slug] = model.split('/');
    if (!author || !slug) throw new Error('Provider routing is unavailable for this model.');
    const response = await this.request(
      `${OPENROUTER_ENDPOINT}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
      {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`OpenRouter provider list is unavailable (${response.status}).`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('OpenRouter provider list is too large.');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('OpenRouter returned an invalid provider list.');
    }
    const providers = parseOpenRouterProviders(body);
    if (!providers.length) throw new Error('No upstream providers are listed for this model.');
    this.cache.set(model, { expiresAt: this.now() + this.ttlMs, providers });
    return providers;
  }
}
