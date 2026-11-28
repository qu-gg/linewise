import type { NodeRuntimeMode } from './host-runtime.js';

let configuredMode: NodeRuntimeMode = 'auto';

export function setNodeRuntimeMode(mode: NodeRuntimeMode): void {
  configuredMode = mode;
}

export function nodeRuntimeMode(): NodeRuntimeMode {
  return configuredMode;
}
