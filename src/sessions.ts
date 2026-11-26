import { sessionTitle, type SavedSession, type StateStore } from './state.js';

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
): void {
  if (replace.id === activeId || replace.turns.length > 0 || changes(replace.id)) return;
  store.data.sessions = store.data.sessions.filter((session) => session.id !== replace.id);
  clearAttachments(replace.id);
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

export function sessionList(data: StateStore['data']) {
  const reviewed = new Set(data.changes.map((change) => change.sessionId));
  return [...data.sessions]
    .reverse()
    .map((saved) => ({
      id: saved.id,
      title: (saved.title ?? saved.label).slice(0, 200),
      root: saved.root,
      archived: saved.archivedAt !== undefined,
      active: data.activeSessionId === saved.id,
      turns: saved.turns.length,
      pendingReview: reviewed.has(saved.id),
      recovering: saved.historyTransition !== undefined,
      lastActivityAt: saved.turns.at(-1)?.endedAt ?? saved.turns.at(-1)?.startedAt ?? 0,
    }))
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
