export function installFixtureGuard(api) {
  const guard = (event, context) => {
    if (context.model?.provider === 'vs-omp-fixture' && context.model.id === 'history')
      return event.payload;
    void context.abort();
    throw new Error('Native fixture refuses every non-scripted model.');
  };
  api.on('before_agent_start', guard);
  api.on('before_provider_request', guard);
}
