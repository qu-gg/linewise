import type { ResolveHook } from 'node:module';

export const resolve: ResolveHook = (specifier, context, next) => {
  if (
    specifier === 'node:fs/promises' &&
    /\/(?:state|extension|session-start|storage-files)\.js$/.test(context.parentURL ?? '')
  )
    return { url: new URL('./fs-fault-fixture.js', import.meta.url).href, shortCircuit: true };
  if (specifier === '@oh-my-pi/pi-natives')
    return { url: new URL('./native-edit-fixture.js', import.meta.url).href, shortCircuit: true };
  if (specifier === 'vscode')
    return { url: new URL('./vscode-fixture.js', import.meta.url).href, shortCircuit: true };
  if (
    ['./acp.js', 'node:child_process'].includes(specifier) &&
    /\/(?:extension|session-start)\.js$/.test(context.parentURL ?? '')
  ) {
    return { url: new URL('./acp-fixture.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
};
