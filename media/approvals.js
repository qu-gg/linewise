let display = {};

function control(action, name, label, id, icon) {
  return `<button type="button" class="icon-button" id="approval-${action}-${id}" data-approval="${action}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
}

function approvalOptions(pending, id, icon) {
  return pending.configurable
    ? `${control('menu', 'chevron-down', 'Approval Options', id, icon)}<div class="approval-menu" role="menu" id="approval-options-${id}" aria-label="Approval Options" hidden><button type="button" role="menuitem" id="approval-settings-${id}" data-approval="settings">${icon('settings-gear')}Configure Command Rules...</button></div>`
    : '';
}

function approvalPreview(pending, escape, icon) {
  return pending.kind === 'command'
    ? `<pre class="approval-command"><code>${escape(pending.summary)}</code></pre>`
    : `<div class="approval-file">${icon('file')}<span>${escape(pending.summary)}</span></div>${pending.destination ? `<div class="approval-file">${icon('arrow-right')}<span>${escape(pending.destination)}</span></div>` : ''}`;
}

function approvalHeader(state, id, icon) {
  return `${state.approvalCount > 1 ? `<span class="approval-count">1/${state.approvalCount}</span>` : ''}${control('expand', display.expanded ? 'screen-normal' : 'screen-full', display.expanded ? 'Restore Confirmation Size' : 'Expand Confirmation Up', id, icon)}${control('close', 'close', 'Skip', id, icon)}`;
}

export function approvalCard(state, { escape, icon }, kind) {
  const pending = state.approval;
  if (display.id !== pending?.id) display = { id: pending?.id };
  if (!pending || pending.kind !== kind) return '';
  const id = escape(pending.id);
  const title = escape(pending.title);
  return `<section id="approval-card-${id}" class="approval-card ${display.expanded ? 'expanded' : ''}" data-approval-id="${id}" role="region" aria-labelledby="approval-title-${id}" tabindex="-1"><header class="approval-header"><h2 id="approval-title-${id}">${title}</h2><div class="approval-header-actions">${approvalHeader(state, id, icon)}</div></header><div class="approval-body">${approvalPreview(pending, escape, icon)}<details class="approval-details" ${display.details ? 'open' : ''}><summary id="approval-details-${id}" data-approval="details">${icon('chevron-right')}Details</summary><pre>${escape(pending.details)}</pre></details></div><div class="approval-meta">${icon('vm')}<span>${escape(state.host ?? 'Local')}</span>${pending.cwd ? `<span class="approval-cwd" title="${escape(pending.cwd)}">${escape(pending.cwd)}</span>` : ''}</div><p class="approval-notice">${escape(pending.notice)}</p><div class="approval-decisions"><div class="approval-split"><button type="button" class="approval-allow" id="approval-allow-${id}" data-approval="allow">Allow Once</button>${approvalOptions(pending, id, icon)}</div><button type="button" class="approval-skip" id="approval-skip-${id}" data-approval="skip">Skip</button></div></section>`;
}

function setMenu(root, open, focus = false) {
  const menu = root.querySelector('.approval-menu');
  if (!menu) return;
  display.menu = open;
  menu.hidden = !open;
  const button = root.querySelector('[data-approval="menu"]');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-controls', menu.id);
  if (open) {
    const bounds = button.getBoundingClientRect();
    menu.style.width = `${Math.min(320, window.innerWidth - 16)}px`;
    menu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - Math.min(320, window.innerWidth - 16) - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(bounds.top - 40, window.innerHeight - 48))}px`;
    if (focus) menu.querySelector('button').focus();
  } else if (focus) button.focus();
}

export function refreshApproval(root) {
  const card = root.querySelector('.approval-card');
  if (!card) return;
  card.classList.toggle('expanded', Boolean(display.expanded));
  const body = card.querySelector('.approval-body');
  body.scrollTop = display.scroll ?? 0;
  const expand = card.querySelector('[data-approval="expand"]');
  expand.hidden = !display.expanded && body.scrollHeight <= body.clientHeight + 1;
  const label = display.expanded ? 'Restore Confirmation Size' : 'Expand Confirmation Up';
  expand.title = label;
  expand.setAttribute('aria-label', label);
  expand.setAttribute('aria-expanded', String(Boolean(display.expanded)));
  expand.firstElementChild.className = `codicon codicon-${display.expanded ? 'screen-normal' : 'screen-full'}`;
  for (const button of card.querySelectorAll('button')) button.disabled = Boolean(display.sent);
  setMenu(card, Boolean(display.menu));
}

function decision(card, action, send) {
  display.sent = true;
  display.menu = false;
  refreshApproval(card.parentElement);
  document.querySelector('#prompt')?.focus({ preventScroll: true });
  send('approval', { id: display.id, decision: action === 'allow' ? 'allow' : 'skip' });
}

function clickApproval(event, send) {
  const button = event.target.closest('[data-approval]');
  const card = button?.closest('.approval-card');
  if (!card) {
    const active = document.querySelector('.approval-card');
    if (active) setMenu(active, false);
    return;
  }
  if (button.disabled || display.sent || card.dataset.approvalId !== display.id) return;
  event.preventDefault();
  const actions = {
    allow: () => decision(card, 'allow', send),
    skip: () => decision(card, 'skip', send),
    close: () => decision(card, 'skip', send),
    menu: () => setMenu(card, !display.menu, true),
    settings: () => {
      setMenu(card, false, true);
      send('approvalSettings', { id: display.id });
    },
    expand: () => {
      display.expanded = !display.expanded;
      refreshApproval(card.parentElement);
    },
    details: () => {
      display.details = !display.details;
      card.querySelector('details').open = display.details;
      refreshApproval(card.parentElement);
    },
  };
  actions[button.dataset.approval]();
}

function menuKey(event, card) {
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && event.target.dataset?.approval === 'menu') {
    event.preventDefault();
    setMenu(card, true, true);
    return true;
  }
  if (!display.menu) return false;
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    card.querySelector('[role="menuitem"]').focus();
    return true;
  }
  if (event.key === 'Tab') setMenu(card, false, true);
  return false;
}

function keyApproval(event) {
  const card = document.querySelector('.approval-card');
  if (!card || menuKey(event, card)) return;
  if (event.key !== 'Escape') return;
  if (display.menu) setMenu(card, false, true);
  else if (display.expanded) {
    display.expanded = false;
    refreshApproval(card.parentElement);
  } else if (display.details) {
    display.details = false;
    card.querySelector('details').open = false;
    card.querySelector('summary').focus();
  } else return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function bindApprovals(send) {
  document.addEventListener('click', (event) => clickApproval(event, send));
  document.addEventListener('keydown', keyApproval);
  window.addEventListener('resize', () => refreshApproval(document));
  document.addEventListener(
    'scroll',
    (event) => {
      if (event.target.classList?.contains('approval-body'))
        display.scroll = event.target.scrollTop;
    },
    true,
  );
}
