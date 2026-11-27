import { changeLineStats } from './review-presentation.js';
import { sessionTitle, type SavedSession, type StateStore } from './state.js';

export function reconcileActiveSession(data: StateStore['data']): void {
  if (
    data.activeSessionId !== undefined &&
    !data.sessions.some((saved) => saved.id === data.activeSessionId)
  )
    data.activeSessionId = undefined;
}

export function assertSessionResumable(saved: SavedSession | undefined) {
  if (saved?.archivedAt !== undefined)
    throw new Error('Restore this archived session before resuming it.');
}

export function dropEmptySession(
  store: StateStore,
  replace: SavedSession,
  activeId: string | undefined,
  changes: (sessionId: string) => number,
  clearAttachments: (sessionId: string) => void,
): SavedSession | undefined {
  if (
    replace.id === activeId ||
    replace.archivedAt !== undefined ||
    replace.historyTransition ||
    replace.turns.length > 0 ||
    changes(replace.id)
  )
    return undefined;
  store.data.sessions = store.data.sessions.filter((session) => session.id !== replace.id);
  clearAttachments(replace.id);
  return replace;
}

export type SessionAction = 'renameSession' | 'archiveSession' | 'restoreSession';
export interface SessionRequest {
  type: SessionAction | 'openSession' | 'resumeSession';
  id: string;
  title?: string;
}
export function isSessionRequest(request: { type: string }): request is SessionRequest {
  return [
    'renameSession',
    'archiveSession',
    'restoreSession',
    'openSession',
    'resumeSession',
  ].includes(request.type);
}

type ChangeTotals = Map<string, { added: number; removed: number }>;

function listedSession(
  saved: SavedSession,
  data: StateStore['data'],
  reviewed: Set<string>,
  totals: ChangeTotals,
) {
  const empty = saved.turns.length === 0;
  const turn = saved.turns.at(-1);
  const total = totals.get(saved.id) ?? { added: 0, removed: 0 };
  return {
    id: saved.id,
    title: (saved.title ?? (empty ? 'New Session' : saved.label)).slice(0, 200),
    root: saved.root,
    archived: saved.archivedAt !== undefined,
    active: data.activeSessionId === saved.id,
    empty,
    titled: saved.title !== undefined,
    turns: saved.turns.length,
    pendingReview: reviewed.has(saved.id),
    recovering: saved.historyTransition !== undefined,
    lastActivityAt: turn?.endedAt ?? turn?.startedAt ?? 0,
    added: total.added,
    removed: total.removed,
  };
}

export function sessionList(data: StateStore['data']) {
  const reviewed = new Set<string>();
  const totals: ChangeTotals = new Map();
  for (const change of data.changes) {
    reviewed.add(change.sessionId);
    const stats = changeLineStats(change);
    const total = totals.get(change.sessionId) ?? { added: 0, removed: 0 };
    total.added += stats.added;
    total.removed += stats.removed;
    totals.set(change.sessionId, total);
  }
  return [...data.sessions]
    .reverse()
    .map((saved) => listedSession(saved, data, reviewed, totals))
    .sort((first, second) => second.lastActivityAt - first.lastActivityAt);
}

export async function editSession(
  store: StateStore,
  id: string,
  action: SessionAction,
  title?: string,
) {
  const renamed = action === 'renameSession' ? sessionTitle.parse(title) : undefined;
  await store.updateSessions((data) => {
    const saved = data.sessions.find((session) => session.id === id);
    if (!saved) throw new Error('The selected session no longer exists.');
    if (saved.historyTransition || saved.turns.some((turn) => turn.status === 'running'))
      throw new Error('Wait for the session operation to finish.');
    if (action === 'archiveSession' && data.activeSessionId === id)
      data.activeSessionId = undefined;
    return data.sessions.map((session) => {
      if (session.id !== id) return session;
      if (action === 'renameSession') return { ...session, title: renamed };
      return { ...session, archivedAt: action === 'archiveSession' ? Date.now() : undefined };
    });
  });
}

export async function inspectSession(store: StateStore, id: string) {
  await store.updateSessions((data) => {
    if (!data.sessions.some((session) => session.id === id))
      throw new Error('The selected session no longer exists.');
    data.activeSessionId = id;
    return data.sessions;
  });
}
