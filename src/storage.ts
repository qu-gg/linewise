import type { SavedSession, StateStore } from './state.js';

type StoredState = StateStore['data'];
type Protection = 'active' | 'running' | 'pending-review' | 'history-recovery' | 'recovery-archive';

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sessionContent(saved: SavedSession) {
  const attachments = saved.turns.flatMap(
    (current) => current.attachments ?? (current.attachment ? [current.attachment] : []),
  );
  const activity = saved.turns.map((current) => current.endedAt ?? current.startedAt);
  return {
    id: saved.id,
    label: saved.label,
    turns: saved.turns.length,
    serializedBytes: bytes(JSON.stringify(saved)),
    attachmentCount: attachments.length,
    attachmentTextBytes: attachments.reduce((total, attached) => total + bytes(attached.text), 0),
    lastActivityAt: activity.reduce<number | undefined>(
      (latest, at) => (latest === undefined ? at : Math.max(latest, at)),
      undefined,
    ),
    nativeFiles: [...new Set([saved.sessionFile, saved.historyTransition?.before.fileName])].filter(
      (name): name is string => name !== undefined,
    ),
  };
}

function protections(data: StoredState) {
  const result = new Map<string, Set<Protection>>();
  const protect = (id: string, reason: Protection) => {
    const reasons = result.get(id) ?? new Set<Protection>();
    reasons.add(reason);
    result.set(id, reasons);
  };
  if (data.activeSessionId !== undefined) protect(data.activeSessionId, 'active');
  for (const change of data.changes) protect(change.sessionId, 'pending-review');
  for (const saved of data.sessions) {
    if (saved.turns.some((current) => current.status === 'running')) protect(saved.id, 'running');
    if (saved.historyTransition) {
      protect(saved.id, 'history-recovery');
      protect(saved.historyTransition.archiveId, 'recovery-archive');
    }
  }
  return result;
}

function reviewTextBytes(changes: StoredState['changes']): number {
  return changes.reduce(
    (total, change) =>
      total +
      [
        change.before,
        change.after,
        change.intermediate,
        change.destination?.after,
        change.hunkIntent?.before,
        change.hunkIntent?.after,
      ].reduce<number>((sum, text) => sum + (typeof text === 'string' ? bytes(text) : 0), 0),
    0,
  );
}

export function planSessionRemoval(data: StoredState, ids: readonly string[]): SavedSession[] {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('Select distinct sessions to remove.');
  const protectedIds = protections(data);
  const known = new Map(data.sessions.map((saved) => [saved.id, saved]));
  if (known.size !== data.sessions.length || [...protectedIds.keys()].some((id) => !known.has(id)))
    throw new Error('Storage references are ambiguous; no sessions can be removed.');
  return ids.map((id) => {
    const saved = known.get(id);
    if (!saved) throw new Error('A selected session no longer exists.');
    if (protectedIds.has(id))
      throw new Error('A selected session is protected by active work or recovery.');
    return saved;
  });
}

export function inspectStorage(data: StoredState) {
  const protectedIds = protections(data);
  const known = new Set(data.sessions.map((saved) => saved.id));
  const sessions = data.sessions.map((saved) => ({
    ...sessionContent(saved),
    protectedBy: [...(protectedIds.get(saved.id) ?? [])],
  }));
  return {
    formatVersion: 1,
    retention: 'manual',
    automaticDeletion: false,
    serializedStateBytes: bytes(JSON.stringify(data)),
    sessionCount: sessions.length,
    protectedSessionCount: sessions.filter((saved) => saved.protectedBy.length > 0).length,
    turnCount: sessions.reduce((total, saved) => total + saved.turns, 0),
    attachmentCount: sessions.reduce((total, saved) => total + saved.attachmentCount, 0),
    attachmentTextBytes: sessions.reduce((total, saved) => total + saved.attachmentTextBytes, 0),
    reviewCount: data.changes.length,
    reviewTextBytes: reviewTextBytes(data.changes),
    missingSessionIds: [...protectedIds.keys()].filter((id) => !known.has(id)),
    sessions,
  };
}
