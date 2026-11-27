function terminals(state, button) {
  return button(
    'terminals',
    'terminal',
    'OMP Terminals',
    !state.connected || !state.busy ? 'disabled' : '',
  );
}

function browser(state, button) {
  return state.browserUrl ? button('openInBrowser', 'globe', 'Open in VS Code Browser') : '';
}

export function toolbar(state, button, escape) {
  const working = state.busy || state.connecting;
  return `<header class="toolbar"><span class="session-name" title="${escape(state.session)}">${escape(state.session ?? 'New Session')}</span><div class="tools">${button('new', 'add', 'New Session', working ? 'disabled' : '')}${button('sessions', 'history', 'Switch Session')}${browser(state, button)}${terminals(state, button)}${button(state.connected ? 'disconnect' : 'connect', state.connected ? 'debug-disconnect' : 'debug-start', state.connected ? 'Disconnect' : 'Start Session', state.connecting ? 'disabled' : '')}${button('output', 'output', 'Show Output')}</div></header>`;
}
