import type { OmpClient } from './acp.js';
import type { HistorySnapshot } from './history.js';
import { cloneSession, reconcileHistory, type SavedSession, type StateStore } from './state.js';

function verifiedTurn(session: SavedSession | undefined, id: string) {
  const index = session?.turns.findIndex((current) => current.id === id) ?? -1;
  const selected = session?.turns[index];
  if (!session || !selected?.history || session.historyTransition)
    throw new Error('This turn has no verified native history boundary.');
  return { session, index, selected, history: selected.history };
}

export function historyBoundary(
  client: OmpClient | undefined,
  session: SavedSession | undefined,
  id: string,
  boundary: 'before' | 'after',
) {
  if (!client?.connected || !client.historyAvailable)
    throw new Error('This turn has no verified native history boundary.');
  const target = verifiedTurn(session, id);
  if (boundary === 'after' && target.selected.status !== 'completed')
    throw new Error('Fork after a completed turn, or fork before this prompt.');
  const entryId =
    boundary === 'before' ? target.history.promptEntryId : target.history.afterEntryId;
  if (!entryId) throw new Error('The requested history boundary is unavailable.');
  return { ...target, client, entryId };
}

interface BranchContext {
  store: StateStore;
  target: ReturnType<typeof historyBoundary>;
  forkId: string;
  before: HistorySnapshot;
  snapshot: HistorySnapshot;
}

async function editConversation({ store, target, forkId, before, snapshot }: BranchContext) {
  const { client, session, entryId, index } = target;
  store.data.sessions.push(
    cloneSession(session, forkId, snapshot, session.turns.length, `${session.label} (before edit)`),
  );
  session.historyTransition = { before, entryId, keepTurns: index, archiveId: forkId };
  await store.save();
  await client.closeSession(forkId);
  const after = await client.history({
    action: 'navigate',
    sessionId: before.sessionId,
    leafId: before.leafId,
    entryId,
  });
  if (reconcileHistory(session, after) !== 'rewound')
    throw new Error('OMP did not move to the requested prompt boundary.');
  await store.save();
}

async function forkConversation(
  context: BranchContext,
  boundary: 'before' | 'after',
  resetPermissions: () => void,
) {
  const { store, target, forkId, snapshot } = context;
  const { client, session, index, entryId } = target;
  const sourceHandle = client.sessionId!;
  const after = await client.history(
    { action: 'navigate', sessionId: snapshot.sessionId, leafId: snapshot.leafId, entryId },
    forkId,
  );
  const cloned = cloneSession(
    session,
    forkId,
    after,
    index + (boundary === 'after' ? 1 : 0),
    `${session.label} (fork)`,
  );
  store.data.sessions.push(cloned);
  store.data.activeSessionId = cloned.id;
  await store.save();
  await client.selectSession(cloned.id).then(resetPermissions);
  await client.closeSession(sourceHandle);
  return cloned;
}

export async function branchConversation(
  store: StateStore,
  target: ReturnType<typeof historyBoundary>,
  boundary: 'before' | 'after',
  editing: boolean,
  resetPermissions: () => void,
) {
  const { client, history, entryId } = target;
  let forkId: string | undefined;
  try {
    const before = await client.history();
    if (
      history.sessionId !== before.sessionId ||
      !before.entries.some((entry) => entry.id === entryId)
    )
      throw new Error('History changed; reconnect before retrying.');
    forkId = (await client.fork()).sessionId;
    const snapshot = await client.history({ action: 'inspect' }, forkId);
    const context = { store, target, forkId, before, snapshot };
    if (editing) {
      await editConversation(context);
      resetPermissions();
    } else return await forkConversation(context, boundary, resetPermissions);
  } catch (error) {
    if (forkId && !store.data.sessions.some((session) => session.id === forkId))
      await client.closeSession(forkId).catch(() => {});
    await client.stop();
    throw error;
  }
  return undefined;
}
