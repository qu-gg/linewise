import type { SessionNotification } from '@agentclientprotocol/sdk';
import { selectOptions, type OmpClient } from './acp.js';
import { providerOf } from './model-picker.js';
import { updateTurn } from './session-updates.js';
import { parseUsage, type SavedSession, type Turn } from './state.js';
import type { HistorySnapshot } from './history.js';
import type { AppliedRoute } from './model-route.js';

export function applyNotification(
  client: OmpClient,
  session: SavedSession | undefined,
  current: Turn | undefined,
  update: SessionNotification['update'],
  commands: string[],
  connecting: boolean,
) {
  if (update.sessionUpdate === 'config_option_update') client.configOptions = update.configOptions;
  if (update.sessionUpdate === 'available_commands_update')
    commands = update.availableCommands.map((command) => command.name);
  applyUsage(session, update, connecting);
  if (current) {
    const model = client.configOptions.find((option) => option.id === 'model')?.currentValue;
    updateTurn(current, update, commands, typeof model === 'string' ? model : undefined);
  }
  return commands;
}

function applyUsage(
  session: SavedSession | undefined,
  update: SessionNotification['update'],
  connecting: boolean,
) {
  if (update.sessionUpdate !== 'usage_update') return;
  const usage = parseUsage(update);
  if (session && usage && !connecting) session.usage = usage;
}

export function applyCompactionUsage(
  session: SavedSession,
  current: Turn,
  before: HistorySnapshot,
  after: HistorySnapshot,
) {
  if (current.status !== 'completed' || before.sessionId !== after.sessionId) return;
  if (!after.contextUsage) return;
  const previous = new Set(before.entries.map((entry) => entry.id));
  if (!after.entries.some((entry) => entry.type === 'compaction' && !previous.has(entry.id)))
    return;
  session.usage = {
    ...session.usage,
    used: after.contextUsage.tokens,
    size: after.contextUsage.contextWindow,
    stale: false,
  };
}

export function connectionPresentation(
  client: OmpClient | undefined,
  session: SavedSession | undefined,
) {
  return {
    connected: Boolean(client?.connected),
    canHistory: Boolean(
      client?.connected && client.historyAvailable && !session?.historyTransition,
    ),
  };
}

export const PROMPT_HISTORY_LIMIT = 50;

interface PromptCandidate {
  prompt: string;
  at: number;
}

function sameRootCandidates(
  sessions: readonly SavedSession[],
  active: SavedSession,
): PromptCandidate[] {
  const candidates: PromptCandidate[] = [];
  for (const saved of sessions) {
    if (saved.id === active.id || saved.root !== active.root) continue;
    for (const turn of saved.turns)
      candidates.push({ prompt: turn.prompt, at: turn.endedAt ?? turn.startedAt });
  }
  return candidates;
}

function uniqueRecent(candidates: readonly PromptCandidate[]): string[] {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.prompt.trim() || seen.has(candidate.prompt)) continue;
    seen.add(candidate.prompt);
    recent.push(candidate.prompt);
    if (recent.length === PROMPT_HISTORY_LIMIT) break;
  }
  return recent;
}

// The composer traverses the active session's prompts from its turns, so recall
// only carries bounded, deduplicated prompts from other retained same-root sessions.
export function promptRecents(
  sessions: readonly SavedSession[],
  active: SavedSession | undefined,
): string[] {
  if (!active) return [];
  const candidates = sameRootCandidates(sessions, active);
  candidates.sort((left, right) => right.at - left.at);
  return uniqueRecent(candidates);
}

export function sessionPresentation(session: SavedSession | undefined) {
  return {
    sessionId: session?.id,
    session: session?.title ?? (session?.turns.length ? session.label : 'New Session'),
    turns: session?.turns ?? [],
    context: session?.usage,
  };
}

export function configPresentation(client: OmpClient | undefined, route?: AppliedRoute) {
  return (client?.configOptions ?? [])
    .filter((option) => ['model', 'thinking'].includes(option.id))
    .map((option) => {
      const value = String(option.currentValue);
      const options = selectOptions(option);
      if (option.id === 'model') {
        const current = options.find((choice) => choice.value === value);
        return {
          id: option.id,
          name: option.name,
          value,
          label: current?.name ?? value,
          provider: providerOf(value),
          route,
        };
      }
      return { id: option.id, name: option.name, value, options };
    });
}
