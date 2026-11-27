export const WIDE_QUERY = '(min-width: 620px)';
const DAY = 86_400_000;
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export const isWide = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;

let display = {
  open: false,
  filter: '',
  editing: null,
  searchOpen: false,
  filtersOpen: false,
  showArchived: false,
  sidebarOpen: true,
};

export const managerState = () => ({
  open: display.open,
  filter: display.filter,
  searchOpen: display.searchOpen,
  showArchived: display.showArchived,
  sidebarOpen: display.sidebarOpen,
});

export function showSessions(open = true) {
  if (open) {
    display.sidebarOpen = true;
    display.filtersOpen = false;
    display.searchOpen = true;
    display.open = !isWide();
    return;
  }
  display.open = false;
  display.searchOpen = false;
  display.filtersOpen = false;
  display.filter = '';
}

function control(action, name, label, id, ui, disabled = false, pressed) {
  const toggled = pressed === undefined ? '' : ` aria-pressed="${pressed}"`;
  return `<button type="button" class="icon-button" data-session="${action}" data-id="${ui.escape(id)}" title="${ui.escape(label)}" aria-label="${ui.escape(label)}"${toggled} ${disabled ? 'disabled' : ''}>${ui.icon(name)}</button>`;
}

function relativeTime(at) {
  const seconds = Math.round((at - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return 'just now';
  if (absolute < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (absolute < 604_800) return relative.format(Math.round(seconds / 86_400), 'day');
  if (absolute < 2_592_000) return relative.format(Math.round(seconds / 604_800), 'week');
  return relative.format(Math.round(seconds / 2_592_000), 'month');
}

function rename(session, ui) {
  return `<div class="session-rename"><input id="session-title" aria-label="Session Title" maxlength="200" value="${ui.escape(display.editing.text)}" ${display.editing.pending ? 'disabled' : ''}>${control('save', 'check', 'Save Session Title', session.id, ui, display.editing.pending)}${control('cancelRename', 'close', 'Cancel Rename', session.id, ui)}</div>`;
}

function sessionDiff(session) {
  if (!session.added && !session.removed) return '';
  return `<span class="session-diff"><span class="added">+${session.added ?? 0}</span><span class="removed">-${session.removed ?? 0}</span></span>`;
}

function sessionTime(session, ui) {
  if (!session.lastActivityAt) return '';
  return `<span class="session-time" title="${ui.escape(new Date(session.lastActivityAt).toLocaleString())}">${ui.escape(relativeTime(session.lastActivityAt))}</span>`;
}

function sessionPending(session, ui) {
  return session.pendingReview
    ? `<span class="session-pending" title="Pending file review" aria-label="Pending file review">${ui.icon('files')}</span>`
    : '';
}

function sessionTurns(session) {
  if (!(session.turns > 0)) return '';
  return `<span class="session-turns">${session.turns} ${session.turns === 1 ? 'prompt' : 'prompts'}</span>`;
}

function sessionContext(session) {
  if (!(session.attachments > 0)) return '';
  return `<span class="session-turns session-context" title="Attached context">${session.attachments} ${session.attachments === 1 ? 'context' : 'contexts'}</span>`;
}

function sessionMeta(session, ui) {
  const parts = `${sessionDiff(session)}${sessionTime(session, ui)}${sessionPending(session, ui)}${sessionTurns(session)}${sessionContext(session)}`;
  return parts ? `<small>${parts}</small>` : '';
}

function sessionActions(session, ui, disabled) {
  const resume = session.archived
    ? ''
    : control('resumeSession', 'play', 'Resume Session', session.id, ui, disabled);
  const archive = session.archived
    ? control('restoreSession', 'discard', 'Restore Session', session.id, ui, disabled)
    : control('archiveSession', 'archive', 'Archive Session', session.id, ui, disabled);
  return `${control('rename', 'edit', 'Rename Session', session.id, ui, disabled)}${resume}${archive}`;
}

function sessionRow(session, state, ui) {
  const disabled = state.busy || state.connecting;
  const body =
    display.editing?.id === session.id
      ? rename(session, ui)
      : `<button type="button" class="session-open" data-session="openSession" data-id="${ui.escape(session.id)}" aria-current="${session.active === true}" title="${ui.escape(session.root)}" ${disabled ? 'disabled' : ''}>${ui.icon(session.archived ? 'archive' : 'comment')}<span class="session-row-text"><strong>${ui.escape(session.title)}</strong>${sessionMeta(session, ui)}</span></button>`;
  return `<li class="session-row ${session.active ? 'active' : ''}">${body}<div class="session-row-actions">${sessionActions(session, ui, disabled)}</div></li>`;
}

function section(id, label, sessions, state, ui) {
  return `<section class="session-group" data-group="${id}" aria-label="${ui.escape(label)}"><h3><span>${ui.escape(label)}</span><span class="session-group-count">${sessions.length}</span></h3><ul class="session-list">${sessions.map((session) => sessionRow(session, state, ui)).join('')}</ul></section>`;
}

function timeGroups(sessions) {
  const now = Date.now();
  const today = new Date(now).setHours(0, 0, 0, 0);
  const yesterday = today - DAY;
  const week = now - 7 * DAY;
  const groups = [
    { id: 'today', label: 'Today', sessions: [] },
    { id: 'yesterday', label: 'Yesterday', sessions: [] },
    { id: 'week', label: 'Last 7 days', sessions: [] },
    { id: 'older', label: 'Older', sessions: [] },
  ];
  for (const session of sessions) {
    const at = session.lastActivityAt ?? 0;
    const group =
      at >= today ? groups[0] : at >= yesterday ? groups[1] : at >= week ? groups[2] : groups[3];
    group.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length);
}

function emptySessionVisible(session, ui) {
  if (
    session.active ||
    session.archived ||
    session.titled ||
    session.pendingReview ||
    session.recovering
  )
    return true;
  if (session.attachments > 0) return true;
  return Boolean(ui.hasDraft?.(session.id));
}

function visibleSession(session, query, ui) {
  if (query && !`${session.title} ${session.root}`.toLocaleLowerCase().includes(query))
    return false;
  return !session.empty || emptySessionVisible(session, ui);
}

function listing(state, ui) {
  if (!state.sessions) return '<p class="session-empty" role="status">Loading sessions...</p>';
  const query = display.filter.toLocaleLowerCase();
  const sessions = state.sessions.filter((session) => visibleSession(session, query, ui));
  const groups = timeGroups(sessions.filter((session) => !session.archived)).map((group) =>
    section(group.id, group.label, group.sessions, state, ui),
  );
  const archived = sessions.filter((session) => session.archived);
  if (display.showArchived && archived.length)
    groups.push(section('archived', 'Archived', archived, state, ui));
  if (groups.length) return groups.join('');
  const message = query
    ? 'No matching sessions.'
    : display.showArchived
      ? 'No sessions.'
      : 'No recent sessions.';
  return `<p class="session-empty" role="status">${message}</p>`;
}

function acknowledgeTitle(state) {
  const saved = state.sessions?.find((session) => session.id === display.editing?.id);
  if (saved && display.editing.pending && saved.title === display.editing.text)
    display.editing = null;
  if (state.error && display.editing) display.editing.pending = false;
}

function panelHeader(state, ui, kind) {
  const stop = state.busy ? ui.button('cancel', 'debug-stop', 'Stop') : '';
  const tail =
    kind === 'session-sidebar'
      ? control('collapse', 'layout-sidebar-right-off', 'Hide Sessions Sidebar', '', ui)
      : control('close', 'close', 'Close Sessions', '', ui);
  return `<header><h2 id="sessions-heading">Sessions</h2><span class="session-header-actions">${stop}${control('refresh', 'refresh', 'Refresh Sessions', '', ui)}${control('toggleSearch', 'search', 'Search Sessions', '', ui, false, display.searchOpen)}${control('filters', 'filter', 'Filter Sessions', '', ui, false, display.filtersOpen)}${tail}</span></header>`;
}

function panelFields(state, ui, kind) {
  const search = display.searchOpen
    ? `<label class="session-search">${ui.icon('search')}<input id="session-search" type="search" aria-label="Search Sessions" placeholder="Search sessions" value="${ui.escape(display.filter)}"></label>`
    : '';
  const filters = display.filtersOpen
    ? `<div class="session-filters" role="group" aria-label="Session Filters"><label><input id="session-show-archived" type="checkbox" ${display.showArchived ? 'checked' : ''}><span>Show archived</span></label></div>`
    : '';
  const busy = state.busy || state.connecting;
  const notice =
    kind === 'session-surface' && (state.approval || state.question)
      ? `<button type="button" class="text-button secondary" data-session="close">${ui.icon('bell')}${state.question ? 'Has Questions' : 'Needs Approval'}</button>`
      : '';
  return `${search}${filters}<button type="button" class="session-new" data-session="new" ${busy ? 'disabled' : ''}>${ui.icon('add')}<span>New Session</span></button>${notice}`;
}

function panel(state, ui, kind) {
  return `<section class="session-manager ${kind}" aria-labelledby="sessions-heading">${panelHeader(state, ui, kind)}${panelFields(state, ui, kind)}<div id="session-results" class="session-results" role="region" aria-label="Session Results">${listing(state, ui)}</div></section>`;
}

export function sessionSidebar(state, ui) {
  return display.sidebarOpen ? panel(state, ui, 'session-sidebar') : '';
}

export function sessionManager(state, ui) {
  if (!display.open) return '';
  acknowledgeTitle(state);
  return panel(state, ui, 'session-surface');
}

function saveTitle(send) {
  if (!display.editing || display.editing.pending || !display.editing.text.trim()) return;
  display.editing.pending = true;
  send('renameSession', { id: display.editing.id, title: display.editing.text.trim() });
}

function actionsFor(send, state, id) {
  const saved = state().sessions?.find((session) => session.id === id);
  return {
    close: () => {
      display.open = false;
    },
    collapse: () => {
      display.sidebarOpen = false;
    },
    toggleSearch: () => {
      display.searchOpen = !display.searchOpen;
      if (!display.searchOpen) display.filter = '';
    },
    filters: () => {
      display.filtersOpen = !display.filtersOpen;
    },
    rename: () => {
      if (saved) display.editing = { id: saved.id, text: saved.title, pending: false };
    },
    cancelRename: () => {
      display.editing = null;
    },
    save: () => saveTitle(send),
    refresh: () => send('refreshSessions'),
    new: () => {
      if (!isWide()) display.open = false;
      send('new');
    },
  };
}

function focusTarget(action) {
  const targets = {
    rename: () => document.querySelector('#session-title'),
    toggleSearch: () => display.searchOpen && document.querySelector('#session-search'),
    filters: () => display.filtersOpen && document.querySelector('#session-show-archived'),
    collapse: () => document.querySelector('[data-action="sessions"]'),
  };
  return targets[action]?.() ?? null;
}

function settleFocus(action, windowWide) {
  const fallback = !display.open && !windowWide ? document.querySelector('#prompt') : null;
  const target = focusTarget(action) ?? fallback;
  if (target && typeof target.focus === 'function')
    target.focus({ preventScroll: action === 'collapse' });
}

function act(button, send, render, state) {
  const action = button.dataset.session;
  const id = button.dataset.id;
  const actions = actionsFor(send, state, id);
  if (actions[action]) actions[action]();
  else {
    send(action, { id });
    if (!isWide() && ['openSession', 'resumeSession'].includes(action)) display.open = false;
  }
  render();
  settleFocus(action, isWide());
}

function escapeLevel() {
  if (display.editing) {
    display.editing = null;
    return display.searchOpen ? '#session-search' : '[data-session="toggleSearch"]';
  }
  if (display.filtersOpen) {
    display.filtersOpen = false;
    return '[data-session="filters"]';
  }
  if (display.searchOpen) {
    display.searchOpen = false;
    display.filter = '';
    return '[data-session="toggleSearch"]';
  }
  if (!display.open) return;
  display.open = false;
  return '#prompt';
}

function closeLevel(event, send, render) {
  if (event.key === 'Escape') {
    event.preventDefault();
    const target = escapeLevel();
    if (!target) return;
    render();
    document.querySelector(target)?.focus();
    return;
  }
  if (event.key === 'Enter' && event.target.id === 'session-title') {
    event.preventDefault();
    saveTitle(send);
    render();
  }
}

export function bindSessions(send, render, state, remembered) {
  if (remembered) display = { ...display, ...remembered, editing: null, filtersOpen: false };
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-session]');
    if (!button || button.disabled) return;
    event.preventDefault();
    act(button, send, render, state);
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'session-search') {
      display.filter = event.target.value;
      render();
    }
    if (event.target.id === 'session-title' && display.editing)
      display.editing.text = event.target.value;
  });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'session-show-archived') {
      display.showArchived = event.target.checked;
      render();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!display.open && !(isWide() && display.sidebarOpen)) return;
    closeLevel(event, send, render);
  });
}
