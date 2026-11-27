import path from 'node:path';
import type { TerminalManager } from './terminal.js';
import type { ShellRequest } from './shell-policy.js';

async function jobOutput(
  manager: TerminalManager,
  sessionId: string,
  input: Extract<ShellRequest, { jobId: string }>,
): Promise<string> {
  const request = { sessionId, terminalId: input.jobId };
  if (input.action === 'reveal' || input.action === 'takeover') {
    if (input.action === 'reveal') manager.reveal(request);
    else await manager.takeover(request);
    return JSON.stringify({ jobId: input.jobId, ...manager.output(request) });
  }
  if (input.action === 'wait') {
    await manager.waitForExit(request);
    return JSON.stringify({ jobId: input.jobId, ...manager.output(request) });
  }
  if (input.action === 'stop') {
    if (manager.isReleased(request))
      return JSON.stringify({ jobId: input.jobId, output: '', truncated: false });
    await manager.kill(request);
  }
  const result = await manager.waitForOutput(request, 'waitMs' in input ? (input.waitMs ?? 0) : 0);
  if (input.action === 'stop') await manager.release(request);
  return JSON.stringify({ jobId: input.jobId, ...result });
}

function commandRequest(
  sessionId: string,
  cwd: string,
  input: Extract<ShellRequest, { command: string }>,
) {
  const node = input.runtime === 'node';
  if (node && Number(process.versions.node.split('.')[0]) < 20)
    throw new Error('The host Node runtime must be version 20+ for JavaScript/Playwright.');
  return {
    sessionId,
    cwd: path.resolve(cwd, input.cwd || '.'),
    command: node ? process.execPath : '/bin/bash',
    args: node ? ['--input-type=module', '-e', input.command] : ['-l', '-c', input.command],
    env: node ? [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] : [],
    outputByteLimit: 65536,
  };
}

export async function executeShell(
  manager: TerminalManager,
  sessionId: string,
  cwd: string,
  input: ShellRequest,
  signal: AbortSignal,
  toolCallId?: string,
): Promise<string> {
  if (!('command' in input)) return jobOutput(manager, sessionId, input);
  const handle = await manager.create(
    commandRequest(sessionId, cwd, input),
    input.action === 'start' || !input.timeout ? null : input.timeout * 1000,
    signal,
    { pty: input.pty ?? false, visibility: input.visibility ?? 'hidden' },
    toolCallId,
  );
  const request = { sessionId, ...handle };
  if (input.action === 'start')
    return JSON.stringify({ jobId: handle.terminalId, ...manager.output(request) });
  try {
    await manager.waitForExit(request);
    return JSON.stringify(manager.output(request));
  } finally {
    if (!signal.aborted) await manager.release(request);
  }
}
