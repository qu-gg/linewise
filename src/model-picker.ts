export interface ModelChoice {
  value: string;
  name: string;
  description?: string;
}

export interface ProviderGroup {
  provider: string;
  count: number;
  models: ModelChoice[];
}

export function providerOf(value: string): string {
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : 'unknown';
}

export function groupModels(choices: readonly ModelChoice[]): ProviderGroup[] {
  const providers = new Map<string, ModelChoice[]>();
  for (const choice of choices) {
    const provider = providerOf(choice.value);
    const models = providers.get(provider);
    if (models) models.push(choice);
    else providers.set(provider, [choice]);
  }
  return [...providers.entries()]
    .map(([provider, models]) => ({ provider, count: models.length, models }))
    .sort(
      (left, right) =>
        left.count - right.count ||
        left.provider.toLowerCase().localeCompare(right.provider.toLowerCase()),
    );
}
