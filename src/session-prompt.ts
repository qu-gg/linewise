import type { OmpClient } from './acp.js';
import { randomUUID } from 'node:crypto';
import { promptBlocks, safeError } from './acp.js';
import type { HostTools } from './host-tools.js';
import type { HistorySnapshot } from './history.js';
import { applyCompactionUsage } from './session-presentation.js';
import { assertNativeBudget } from './storage-files.js';
import { TerminalStreamController } from './terminal-stream.js';
import type { TerminalStreamMessage } from './terminal-stream.js';
import { markPromptSent } from './stream-metrics.js';
import {
  bindTurnHistory,
  type Attachment,
  type SavedSession,
  type StateStore,
  type Turn,
} from './state.js';

interface PromptRun {
  client: OmpClient;
  tools: HostTools;
  store: StateStore;
  session: SavedSession;
  current: Turn;
  attached: Attachment[];
  abort: AbortController;
  cwd: string;
  valid: () => boolean;
  release: () => void;
  finishTools: () => Promise<void>;
  log: (message: string) => void;
  sendLive: (message: TerminalStreamMessage) => void;
}

export function startTurn(session: SavedSession, text: string, attachments: Attachment[]): Turn {
  const current: Turn = {
    id: randomUUID(),
    prompt: text,
    startedAt: Date.now(),
    status: 'running',
    blocks: [],
    attachment: attachments[0],
    attachments,
  };
  session.turns.push(current);
  if (session.turns.length === 1) session.label = text.replace(/\s+/g, ' ').slice(0, 60);
  return current;
}

async function finishHistory(run: PromptRun, before: HistorySnapshot | undefined) {
  const { client, current, session } = run;
  if (!before || !client.connected || !run.valid()) return;
  try {
    const after = await client.history();
    if (run.valid()) applyCompactionUsage(session, current, before, after);
    bindTurnHistory(current, before, after);
    session.sessionFile = after.fileName;
  } catch (error) {
    client.historyAvailable = false;
    run.log(`History controls disabled until reconnect: ${safeError(error)}`);
  }
}

export async function runPrompt(run: PromptRun): Promise<void> {
  const { client, tools, store, session, current, abort } = run;
  const live = new TerminalStreamController({
    turn: () => current,
    observe: (terminalId, listener) =>
      tools.observeOutput({ sessionId: client.sessionId!, terminalId }, listener),
    send: run.sendLive,
  });
  const stopLive = () => live.close();
  abort.signal.addEventListener('abort', stopLive, { once: true });
  let before: HistorySnapshot | undefined;
  try {
    const result = await tools.run(
      {
        sessionId: client.sessionId!,
        owner: session.id,
        turnId: current.id,
        cwd: run.cwd,
        signal: abort.signal,
        valid: run.valid,
        observeTerminal: (terminal) => live.terminal(terminal),
      },
      async () => {
        await assertNativeBudget(store, session.id);
        if (client.historyAvailable) before = await client.history();
        await store.save();
        abort.signal.throwIfAborted();
        markPromptSent(current);
        return client.prompt(promptBlocks(current.prompt, run.attached));
      },
    );
    current.status = result.stopReason === 'cancelled' ? 'cancelled' : 'completed';
  } catch (error) {
    current.status = tools.cleanupFailed || !abort.signal.aborted ? 'failed' : 'cancelled';
    if (tools.cleanupFailed) await run.finishTools().finally(() => client.stop());
    if (current.status === 'failed') throw error;
  } finally {
    await finishHistory(run, before);
    current.endedAt = Date.now();
    run.release();
    abort.abort();
    abort.signal.removeEventListener('abort', stopLive);
    live.close();
    await store.save();
  }
}
