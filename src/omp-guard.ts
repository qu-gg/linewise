import { stat } from 'node:fs/promises';
import path from 'node:path';
import { stagePermit } from './mutations.js';
import installHistory from './history.js';
import type { HistoryApi } from './history.js';
import { checkedPath, pathReason } from './file-policy.js';
import { installNativeEdit } from './native-edit.js';
import type { NativeEditApi } from './native-edit.js';

const allowedTools = ['read', 'write', 'todo', 'retain', 'recall', 'memory_edit', 'edit', 'bash'];

export interface GuardEvent {
  toolCallId?: string;
  toolName: string;
  input: Record<string, unknown>;
}

type GuardApi = HistoryApi &
  NativeEditApi & {
    on(event: 'session_start', handler: () => Promise<void>): void;
    on(
      event: 'tool_call',
      handler: (
        event: GuardEvent,
        context: { cwd: string },
      ) => Promise<{ block: true; reason: string } | undefined>,
    ): void;
    setActiveTools(names: string[]): Promise<void>;
  };

export function guardReason(event: GuardEvent): string | undefined {
  if (!allowedTools.includes(event.toolName))
    return 'This tool is disabled until its mutation routes are verified.';
  if (event.toolName === 'bash') return shellReason(event.input);
  if (event.toolName === 'edit') return editReason(event.input);
  if (event.toolName !== 'read' && event.toolName !== 'write') return;
  const reason = pathReason(event.input.path);
  if (reason) return reason;
  if (
    event.toolName === 'write' &&
    (typeof event.input.content !== 'string' || event.input.content.includes('#!'))
  ) {
    return 'Non-text writes and executable-bit side effects are disabled in this feasibility build.';
  }
}

function shellReason(input: Record<string, unknown>): string | undefined {
  if (process.platform !== 'linux') return 'Shell execution is supported only on Linux.';
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 65536)
    return 'A bounded explicit shell command is required.';
  if (Object.keys(input).some((key) => !['command', 'i'].includes(key)))
    return 'Service, async, PTY and extra shell arguments are disabled.';
}

function editReason(input: Record<string, unknown>): string | undefined {
  if (typeof input.input !== 'string' || !input.input.trim() || input.input.length > 128 * 1024)
    return 'A bounded native edit input is required.';
}

async function stageShell(event: GuardEvent): Promise<{ block: true; reason: string } | undefined> {
  try {
    const root = process.env.VS_OMP_ARTIFACTS_ROOT;
    if (!root || !event.toolCallId) throw new Error('Shell scope is unavailable.');
    await stagePermit(
      path.join(root, 'mutations'),
      event.toolCallId,
      JSON.stringify({ command: event.input.command }),
    );
  } catch {
    return { block: true, reason: 'No active host prompt owns this shell call.' };
  }
}

export default async function installGuard(
  api: GuardApi,
  initialize = installNativeEdit,
): Promise<void> {
  await initialize(api);
  installHistory(api);
  api.on('session_start', async () => {
    await api.setActiveTools(allowedTools);
  });
  api.on(
    'tool_call',
    async (
      event: GuardEvent,
      context: { cwd: string },
    ): Promise<{ block: true; reason: string } | undefined> => {
      const reason = guardReason(event);
      if (reason) return { block: true, reason };
      if (event.toolName === 'bash') return stageShell(event);
      if (event.toolName !== 'read' && event.toolName !== 'write') return;
      let resolved: string;
      try {
        resolved = await checkedPath(event.input.path as string, context.cwd);
      } catch (error) {
        return { block: true, reason: (error as Error).message };
      }
      if (event.toolName === 'read') {
        const metadata = await stat(resolved);
        if (!metadata.isFile() || metadata.size > 1024 * 1024) {
          return { block: true, reason: 'Only regular text files up to 1 MiB are supported.' };
        }
      }
    },
  );
}
