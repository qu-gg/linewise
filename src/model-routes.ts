import { z } from 'zod';

export interface RouteOption {
  value: string;
  name: string;
  description?: string;
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
}

interface ProviderGroup {
  name: string;
  tags: Set<string>;
  available: boolean;
}

function providerName(raw: string | undefined, slug: string): string {
  return (
    (raw ?? slug)
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, 100) || slug
  );
}

function endpointProvider(raw: unknown): EndpointProvider | undefined {
  const endpoint = providerEndpoint.safeParse(raw);
  if (!endpoint.success) return undefined;
  const { tag, provider_name: name, status } = endpoint.data;
  const slug = tag.split('/')[0]?.toLowerCase();
  if (!slug || !PROVIDER_SLUG.test(slug)) return undefined;
  return {
    slug,
    name: providerName(name, slug),
    tag,
    available: status === undefined || status >= 0,
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
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

/** Group OpenRouter's per-endpoint rows into one selectable option per provider slug. */
export function parseOpenRouterProviders(body: unknown): RouteOption[] {
  const parsed = providerResponse.safeParse(body);
  if (!parsed.success) throw new Error('Invalid OpenRouter provider list.');
  const providers = new Map<string, ProviderGroup>();
  for (const raw of parsed.data.data.endpoints) {
    const endpoint = endpointProvider(raw);
    if (!endpoint) continue;
    const current = providers.get(endpoint.slug);
    if (current) {
      current.tags.add(endpoint.tag);
      current.available ||= endpoint.available;
    } else {
      providers.set(endpoint.slug, {
        name: endpoint.name,
        tags: new Set([endpoint.tag]),
        available: endpoint.available,
      });
    }
  }
  return providerOptions(providers);
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
