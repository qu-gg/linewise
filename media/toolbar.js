export function permissions(state, working, icon) {
  const [label, name] = {
    ask: ['Ask', 'shield'],
    rules: ['Rules', 'checklist'],
    all: ['Allow All', 'unlock'],
    yolo: ['YOLO', 'warning'],
  }[state.permissions] ?? ['Rules', 'checklist'];
  const title = `Command Permissions: ${state.permissions === 'all' ? 'Allow All Except Restrictions' : label}`;
  return `<button type="button" class="icon-button context-toggle permission-control" data-action="permissions" aria-label="${title}" title="${title}" ${!state.connected || working ? 'disabled' : ''}>${icon(name)}<span>${label}</span>${icon('chevron-down')}</button>`;
}

function terminals(state, button) {
  return button(
    'terminals',
    'terminal',
    'OMP Terminals',
    !state.connected || !state.busy ? 'disabled' : '',
  );
}

export function toolbar(state, button, escape) {
  const working = state.busy || state.connecting;
  return `<header class="toolbar"><span class="session-name" title="${escape(state.session)}">${escape(state.session ?? 'New Session')}</span><div class="tools">${button('new', 'add', 'New Session', working ? 'disabled' : '')}${button('sessions', 'history', 'Switch Session')}${terminals(state, button)}${button(state.connected ? 'disconnect' : 'connect', state.connected ? 'debug-disconnect' : 'debug-start', state.connected ? 'Disconnect' : 'Start Session', state.connecting ? 'disabled' : '')}${button('output', 'output', 'Show Output')}</div></header>`;
}
