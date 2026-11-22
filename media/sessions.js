let display = { open: false, tab: 'recent', filter: '', editing: null };

export const managerState = () => ({
  open: display.open,
  tab: display.tab,
  filter: display.filter,
});
export function showSessions(open = true) {
  display.open = open;
}

function control(action, name, label, id, ui, disabled = false) {
  return `<button type="button" class="icon-button" data-session="${action}" data-id="${ui.escape(id)}" title="${ui.escape(label)}" aria-label="${ui.escape(label)}" ${disabled ? 'disabled' : ''}>${ui.icon(name)}</button>`;
}

function rename(session, ui) {
  return `<div class="session-rename"><input id="session-title" aria-label="Session Title" maxlength="200" value="${ui.escape(display.editing.text)}" ${display.editing.pending ? 'disabled' : ''}>${control('save', 'check', 'Save Session Title', session.id, ui, display.editing.pending)}${control('cancelRename', 'close', 'Cancel Rename', session.id, ui)}</div>`;
}

function sessionRow(session, state, ui) {
  const disabled = state.busy || state.connecting;
  return `<li class="session-row ${session.active ? 'active' : ''}">${display.editing?.id === session.id ? rename(session, ui) : `<button type="button" class="session-open" data-session="openSession" data-id="${ui.escape(session.id)}" aria-current="${session.active === true}" title="${ui.escape(session.root)}" ${disabled ? 'disabled' : ''}>${ui.icon(session.archived ? 'archive' : 'comment')}<span><strong>${ui.escape(session.title)}</strong><small>${ui.escape(session.root)}</small></span></button>`}<div class="session-row-actions">${session.pendingReview ? `<span title="Pending file review" aria-label="Pending file review">${ui.icon('files')}</span>` : ''}${control('rename', 'edit', 'Rename Session', session.id, ui, disabled)}${session.archived ? control('restoreSession', 'discard', 'Restore Session', session.id, ui, disabled) : `${control('resumeSession', 'play', 'Resume Session', session.id, ui, disabled)}${control('archiveSession', 'archive', 'Archive Session', session.id, ui, disabled)}`}</div></li>`;
}

function listing(state, ui) {
  if (!state.sessions) return '<p class="session-empty" role="status">Loading sessions...</p>';
  const query = display.filter.toLocaleLowerCase();
  const sessions = state.sessions.filter(
    (session) =>
      session.archived === (display.tab === 'archived') &&
      `${session.title} ${session.root}`.toLocaleLowerCase().includes(query),
  );
  if (!sessions.length)
    return `<p class="session-empty" role="status">${query ? 'No matching sessions.' : display.tab === 'archived' ? 'No archived sessions.' : 'No recent sessions.'}</p>`;
  return `<ul class="session-list" aria-label="${display.tab === 'archived' ? 'Archived Sessions' : 'Recent Sessions'}">${sessions.map((session) => sessionRow(session, state, ui)).join('')}</ul>`;
}

function acknowledgeTitle(state) {
  const saved = state.sessions?.find((session) => session.id === display.editing?.id);
  if (saved && display.editing.pending && saved.title === display.editing.text)
    display.editing = null;
  if (state.error && display.editing) display.editing.pending = false;
}

export function sessionManager(state, ui) {
  if (!display.open) return '';
  acknowledgeTitle(state);
  return `<section class="session-manager" aria-labelledby="sessions-heading"><header><h2 id="sessions-heading">Sessions</h2><span>${control('new', 'add', 'New Session', '', ui, state.busy || state.connecting)}${control('refresh', 'refresh', 'Refresh Sessions', '', ui)}${state.busy ? ui.button('cancel', 'debug-stop', 'Stop') : ''}${control('close', 'close', 'Close Sessions', '', ui)}</span></header><label class="session-search">${ui.icon('search')}<input id="session-search" type="search" aria-label="Search Sessions" placeholder="Search sessions" value="${ui.escape(display.filter)}"></label><div class="session-tabs" role="tablist" aria-label="Session Views">${sessionTab('recent', 'Recent')}${sessionTab('archived', 'Archived')}</div>${state.approval || state.question ? `<button type="button" class="text-button secondary" data-session="close">${ui.icon('bell')}${state.question ? 'Has Questions' : 'Needs Approval'}</button>` : ''}<div id="session-results" class="session-results" role="tabpanel" aria-labelledby="sessions-${display.tab}">${listing(state, ui)}</div></section>`;
}

function sessionTab(id, label) {
  const selected = display.tab === id;
  return `<button type="button" id="sessions-${id}" role="tab" data-session="${id}" aria-selected="${selected}" aria-controls="session-results" tabindex="${selected ? 0 : -1}">${label}</button>`;
}

function navigateTabs(event, render) {
  const other = display.tab === 'recent' ? 'archived' : 'recent';
  const tab = { ArrowLeft: other, ArrowRight: other, Home: 'recent', End: 'archived' }[event.key];
  if (!tab) return;
  event.preventDefault();
  display.tab = tab;
  render();
  document.querySelector(`#sessions-${tab}`)?.focus();
}

function saveTitle(send) {
  if (!display.editing || display.editing.pending || !display.editing.text.trim()) return;
  display.editing.pending = true;
  send('renameSession', { id: display.editing.id, title: display.editing.text.trim() });
}

function act(button, send, render, state) {
  const action = button.dataset.session;
  const id = button.dataset.id;
  const actions = {
    close: () => {
      display.open = false;
    },
    recent: () => {
      display.tab = 'recent';
    },
    archived: () => {
      display.tab = 'archived';
    },
    rename: () => {
      display.editing = {
        id,
        text: state().sessions.find((session) => session.id === id).title,
        pending: false,
      };
    },
    cancelRename: () => {
      display.editing = null;
    },
    save: () => saveTitle(send),
    refresh: () => send('refreshSessions'),
    new: () => {
      display.open = false;
      send('new');
    },
  };
  if (actions[action]) actions[action]();
  else {
    send(action, { id });
    if (['openSession', 'resumeSession'].includes(action)) display.open = false;
  }
  render();
  if (action === 'rename') document.querySelector('#session-title')?.focus();
  if (!display.open) document.querySelector('#prompt')?.focus({ preventScroll: true });
}

export function bindSessions(send, render, state, remembered) {
  if (remembered) display = { ...display, ...remembered, editing: null };
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
  document.addEventListener('keydown', (event) => {
    if (!display.open) return;
    if (event.target.getAttribute('role') === 'tab') navigateTabs(event, render);
    if (event.key === 'Escape') {
      event.preventDefault();
      if (display.editing) display.editing = null;
      else display.open = false;
      render();
      document.querySelector(display.open ? '#session-search' : '#prompt')?.focus();
    }
    if (event.key === 'Enter' && event.target.id === 'session-title') {
      event.preventDefault();
      saveTitle(send);
      render();
    }
  });
}
