const modes = [
  {
    mode: 'ask',
    label: 'Ask Every Time',
    icon: 'shield',
    detail: 'Confirm every command, including read-only ones.',
  },
  {
    mode: 'rules',
    label: 'Command Rules',
    icon: 'checklist',
    detail: 'Built-in read-only approvals and your allow/deny/ask rules. Default.',
  },
  {
    mode: 'all',
    label: 'Allow All Except Restrictions',
    icon: 'unlock',
    detail: 'Skip most prompts. Deny, ask and conservative sensitive-command checks remain.',
    elevated: true,
  },
  {
    mode: 'yolo',
    label: 'YOLO Commands',
    icon: 'warning',
    detail: 'Skip prompts with a best-effort dangerous-command denylist.',
    elevated: true,
  },
];

const warnings = {
  all: {
    title: 'Enable Allow All?',
    action: 'Enable Allow All',
    body: 'Commands run with your host permissions, without an OS sandbox. They can delete files or send data. Explicit deny rules still block; ask rules and uncertain syntax still prompt. File approvals, tool restrictions and Stop stay unchanged. This choice lasts for this workbench window and resets on extension reload, workspace trust change, or history rollback.',
  },
  yolo: {
    title: 'Enable YOLO?',
    action: 'Enable YOLO',
    body: 'Commands run with your host permissions, without an OS sandbox, and can delete files or send data. Shell expansions, redirects and destructive project operations are auto-approved. A small dangerous-command denylist and explicit deny/ask rules remain, but hidden actions in scripts, variables or interpreters cannot be detected reliably. File review, outside-file approvals, web/browser consent, tool restrictions and Stop stay unchanged. This choice lasts for this workbench window and resets on extension reload, workspace trust change, or history rollback.',
  },
};

let display = { open: false, pending: undefined, session: undefined };

const labels = { ask: 'Ask', rules: 'Rules', all: 'Allow All', yolo: 'YOLO' };

function triggerLabel(mode) {
  return labels[mode] ?? 'Rules';
}

function close(render, restore = true) {
  if (!display.open) return;
  display = { open: false, pending: undefined, session: display.session };
  render();
  if (restore)
    requestAnimationFrame(() =>
      document.querySelector('[data-action="permissions"]')?.focus({ preventScroll: true }),
    );
}

function focus(selector) {
  requestAnimationFrame(() => document.querySelector(selector)?.focus({ preventScroll: true }));
}

function modeButton(entry, current, icon) {
  const checked = entry.mode === current;
  return `<button type="button" role="radio" id="permission-mode-${entry.mode}" class="permission-mode" data-permission="mode" data-mode="${entry.mode}" aria-checked="${checked}">${icon(entry.icon)}<span class="permission-mode-text"><span class="permission-mode-label">${entry.label}${entry.elevated ? '<span class="permission-tag">Window only</span>' : ''}</span><span class="permission-mode-detail">${entry.detail}</span></span>${checked ? icon('check') : ''}</button>`;
}

function warningPanel(mode) {
  const warning = warnings[mode];
  return `<div class="permission-warning" role="alert"><h3>${warning.title}</h3><p>${warning.body}</p><div class="permission-decisions"><button type="button" class="permission-primary" id="permission-confirm" data-permission="confirm">${warning.action}</button><button type="button" class="permission-secondary" id="permission-cancel" data-permission="cancel">Cancel</button></div></div>`;
}

function popover(state, icon) {
  const current = state.permissions ?? 'rules';
  const body = display.pending
    ? warningPanel(display.pending)
    : `<div class="permission-modes" role="radiogroup" aria-label="Command permission mode">${modes.map((entry) => modeButton(entry, current, icon)).join('')}</div><p class="permission-notice">Not an OS sandbox. Outside-workspace file and web consent stay independent.</p><button type="button" class="permission-settings" id="permission-settings" data-permission="settings">${icon('settings-gear')}Edit User Command Rules...</button>`;
  return `<section class="permission-popover" role="dialog" aria-labelledby="permission-title" tabindex="-1"><header><h2 id="permission-title">Command Permissions</h2><button type="button" class="icon-button" id="permission-close" data-permission="close" aria-label="Close Command Permissions" title="Close">${icon('close')}</button></header>${body}</section>`;
}

function modeOf(state) {
  return state.permissions ?? 'rules';
}

function permissionTitle(mode) {
  return `Command Permissions: ${mode === 'all' ? 'Allow All Except Restrictions' : triggerLabel(mode)}`;
}

function permissionTrigger(state, busy, icon, mode, title) {
  return `<button type="button" class="icon-button context-toggle permission-control" data-action="permissions" aria-label="${title}" title="${title}" aria-haspopup="dialog" aria-expanded="${display.open}" ${!state.connected || busy ? 'disabled' : ''}>${icon(modes.find((entry) => entry.mode === mode)?.icon ?? 'checklist')}<span>${triggerLabel(mode)}</span>${icon('chevron-down')}</button>`;
}

export function permissionControl(state, busy, icon) {
  if (!state.connected || busy || display.session !== state.sessionId) {
    display = { open: false, pending: undefined, session: state.sessionId };
  }
  const mode = modeOf(state);
  const trigger = permissionTrigger(state, busy, icon, mode, permissionTitle(mode));
  return display.open ? `${trigger}${popover(state, icon)}` : trigger;
}

export function togglePermissions(render, currentState) {
  if (display.open) {
    close(render);
    return;
  }
  const state = currentState();
  display = { open: true, pending: undefined, session: state.sessionId };
  render();
  focus(`#permission-mode-${modeOf(state)}`);
}

function dismissPending(render, currentState) {
  display.pending = undefined;
  render();
  focus(`#permission-mode-${modeOf(currentState())}`);
}

function chooseMode(send, render, currentState, mode) {
  if (mode === modeOf(currentState())) close(render);
  else if (mode === 'all' || mode === 'yolo') {
    display.pending = mode;
    render();
    focus('#permission-confirm');
  } else {
    send('permissions', { mode });
    close(render);
  }
}

function handlePermissionAction(event, send, render, currentState) {
  const target = event.target.closest?.('[data-permission]');
  if (!target) return false;
  event.preventDefault();
  const action = target.dataset.permission;
  if (action === 'mode') chooseMode(send, render, currentState, target.dataset.mode);
  else if (action === 'confirm' && display.pending) {
    send('permissions', { mode: display.pending, confirmed: true });
    close(render);
  } else if (action === 'cancel') dismissPending(render, currentState);
  else if (action === 'settings') {
    send('permissionSettings');
    close(render);
  } else if (action === 'close') close(render);
  return true;
}

function moveModeFocus(mode, key) {
  const options = [...document.querySelectorAll('.permission-mode')];
  const index = options.indexOf(mode);
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? options.length - 1
        : (index + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[next]?.focus({ preventScroll: true });
}

function handlePermissionKey(event, render, currentState) {
  if (!display.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (display.pending) dismissPending(render, currentState);
    else close(render);
    return;
  }
  const mode = event.target.closest?.('.permission-mode');
  if (!mode || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  moveModeFocus(mode, event.key);
}

export function bindPermissions(send, render, currentState) {
  document.addEventListener('click', (event) => {
    if (handlePermissionAction(event, send, render, currentState)) return;
    if (!display.open) return;
    if (event.target.closest?.('.permission-popover, [data-action="permissions"]')) return;
    close(render, false);
  });
  document.addEventListener('keydown', (event) => handlePermissionKey(event, render, currentState));
}
