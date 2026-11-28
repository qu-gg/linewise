import type { ResolveHook } from 'node:module';

export const resolve: ResolveHook = (specifier, context, next) => {
  if (specifier === 'vscode')
    return { url: new URL('./vscode-pr-fixture.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
};
