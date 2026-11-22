import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputResponse,
} from '@agentclientprotocol/sdk';
import type { TaskRequest } from './task-policy.js';
import type { TerminalManager } from './terminal.js';
import { TaskReadinessError } from './task-readiness.js';

export type TaskGraphNode = NonNullable<TaskRequest['graph']>[number];

export interface TaskGraphBackground {
  snapshot: TerminalOutputResponse;
  completion: Promise<TerminalOutputResponse>;
  dispose(): Promise<void>;
}

export type TaskGraphExecution = TerminalOutputResponse | TaskGraphBackground;

export async function runCapturedTaskGraph<
  Capture extends { node: TaskGraphNode; command: Omit<CreateTerminalRequest, 'sessionId'> },
>(
  input: TaskRequest,
  captured: Capture[],
  manager: TerminalManager,
  scope: { sessionId: string; signal: AbortSignal },
  recapture: (signal: AbortSignal) => Promise<Capture[]>,
  execute: (
    entry: Capture,
    reservation: { signal: AbortSignal; start(): Promise<CreateTerminalResponse> },
  ) => Promise<TaskGraphExecution>,
) {
  const reservation = await manager.reserve(
    captured.map((entry) => ({
      sessionId: scope.sessionId,
      ...entry.command,
      outputByteLimit: 65536,
    })),
    scope.signal,
  );
  const validate = async (signal: AbortSignal) => {
    if (JSON.stringify(await recapture(signal)) !== JSON.stringify(captured))
      throw new Error('Task graph definition changed after consent.');
  };
  try {
    await validate(scope.signal);
    const timeout = input.timeout ? input.timeout * 1000 : null;
    return await runTaskGraph(
      input,
      (node, signal) => {
        const index = captured.findIndex((entry) => entry.node.id === node.id);
        return execute(captured[index]!, {
          signal,
          start: () => reservation.start(index, timeout, () => validate(signal), signal),
        });
      },
      scope.signal,
    );
  } finally {
    reservation.dispose();
  }
}

function graphNodes(input: TaskRequest) {
  const nodes = input.graph;
  if (!nodes) throw new Error('An explicit OMP-owned task graph is required.');
  const identities = nodes.map((node) => JSON.stringify([node.name, node.source]));
  if (
    new Set(nodes.map((node) => node.id)).size !== nodes.length ||
    new Set(identities).size !== nodes.length
  )
    throw new Error('Task graph has duplicate identities.');
  const roots = nodes.filter((node) => node.name === input.name && node.source === input.source);
  if (roots.length !== 1) throw new Error('Task graph root is missing or ambiguous.');
  if (roots[0]!.readiness) throw new Error('Task graph final root must be foreground.');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes)
    if (node.dependsOn.some((id) => !byId.has(id)))
      throw new Error('Task graph dependency is missing.');
  return { nodes, byId, root: roots[0]! };
}

function reachableTasks(root: TaskGraphNode, byId: Map<string, TaskGraphNode>) {
  const reached = new Set<string>();
  const pending = [root.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...byId.get(id)!.dependsOn);
  }
  return reached;
}

export function taskGraphLayers(input: TaskRequest): TaskGraphNode[][] {
  const { nodes, byId, root } = graphNodes(input);
  if (reachableTasks(root, byId).size !== nodes.length)
    throw new Error('Task graph contains unrelated nodes.');
  const completed = new Set<string>();
  const layers: TaskGraphNode[][] = [];
  while (completed.size < nodes.length) {
    const layer = nodes.filter(
      (node) => !completed.has(node.id) && node.dependsOn.every((id) => completed.has(id)),
    );
    if (!layer.length) throw new Error('Task graph contains a cycle.');
    layers.push(layer);
    for (const node of layer) completed.add(node.id);
  }
  return layers;
}

export async function runTaskGraph(
  input: TaskRequest,
  execute: (node: TaskGraphNode, signal: AbortSignal) => Promise<TaskGraphExecution>,
  signal: AbortSignal,
) {
  const layers = taskGraphLayers(input);
  const abort = new AbortController();
  const owned = AbortSignal.any([signal, abort.signal]);
  const results = graphResults(input);
  const backgrounds = new Map<string, TaskGraphBackground>();
  let closing = false;
  const run = async (node: TaskGraphNode) => {
    try {
      owned.throwIfAborted();
      const execution = await execute(node, owned);
      if ('completion' in execution) {
        backgrounds.set(node.id, execution);
        Object.assign(results.get(node.id)!, execution.snapshot, {
          status: 'ready',
          readiness: 'ready',
        });
        void execution.completion.then(
          (result) => {
            if (closing) return;
            Object.assign(results.get(node.id)!, result, {
              status: 'failed',
              error: 'Background task exited before graph completion.',
            });
            abort.abort(new Error('Task graph background prerequisite exited.'));
          },
          () => {
            if (!closing) abort.abort(new Error('Task graph background execution failed.'));
          },
        );
      } else {
        const passed = execution.exitStatus?.exitCode === 0;
        Object.assign(results.get(node.id)!, execution, { status: passed ? 'passed' : 'failed' });
        if (!passed) abort.abort(new Error('Task graph prerequisite failed.'));
      }
    } catch (error) {
      results.get(node.id)!.status = owned.aborted ? 'cancelled' : 'failed';
      if (error instanceof TaskReadinessError)
        Object.assign(results.get(node.id)!, error.snapshot, {
          readiness: 'failed',
          error: error.message,
        });
      abort.abort(new Error('Task graph execution failed.'));
    }
  };
  try {
    for (const layer of layers) {
      await Promise.all(layer.map(run));
      if (owned.aborted) break;
    }
  } finally {
    closing = true;
    await cleanupGraph(backgrounds, results, owned.aborted);
  }
  signal.throwIfAborted();
  return { status: abort.signal.aborted ? 'failed' : 'passed', results: [...results.values()] };
}

async function cleanupGraph(
  backgrounds: Map<string, TaskGraphBackground>,
  results: ReturnType<typeof graphResults>,
  aborted: boolean,
) {
  const cleanup = await Promise.allSettled(
    [...backgrounds].map(async ([id, execution]) => {
      await execution.dispose();
      const result = await execution.completion;
      const previous = results.get(id)!;
      Object.assign(previous, result, {
        status: previous.status === 'failed' ? 'failed' : aborted ? 'cancelled' : 'exited',
        cleanup: aborted ? 'graph-failed-or-cancelled' : 'graph-complete',
      });
    }),
  );
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Task graph cleanup failed.',
    );
}

function graphResults(input: TaskRequest) {
  return new Map(
    input.graph!.map((node) => [
      node.id,
      {
        id: node.id,
        name: node.name,
        source: node.source,
        status: 'not-started',
      } as {
        id: string;
        name: string;
        source: string;
        status: string;
        readiness?: string;
        error?: string;
        cleanup?: string;
      } & Partial<TerminalOutputResponse>,
    ]),
  );
}
