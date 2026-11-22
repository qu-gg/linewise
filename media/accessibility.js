function identity(element) {
  if (element.id) return { id: element.id };
  if (element.dataset.focus) return { focus: element.dataset.focus };
  if (element.getAttribute('role') === 'dialog')
    return { dialog: element.getAttribute('aria-labelledby') };
  if (element.tagName === 'SUMMARY')
    return { disclosure: element.parentElement.dataset.disclosure };
  if (element.dataset.action)
    return {
      action: element.dataset.action,
      id: element.dataset.id,
      hunkId: element.dataset.hunkId,
    };
  return null;
}

export function settleAttentionFocus(root, action) {
  const document = root.ownerDocument;
  const settle = () => {
    if (document.hasFocus() && document.activeElement === document.body) action();
  };
  requestAnimationFrame(() => {
    if (document.hasFocus()) settle();
    else document.defaultView.addEventListener('focus', settle, { once: true });
  });
}

export function captureFocus(root) {
  if (!root.ownerDocument.hasFocus()) return null;
  const active = root.ownerDocument.activeElement;
  if (!root.contains(active)) return null;
  return { identity: identity(active), start: active.selectionStart, end: active.selectionEnd };
}

export function restoreFocus(root, saved) {
  if (!saved?.identity) return;
  const wanted = saved.identity;
  const candidates = root.querySelectorAll(
    '[id], [data-action], [data-focus], [role="dialog"], summary',
  );
  const target = Array.from(candidates).find(
    (candidate) => JSON.stringify(identity(candidate)) === JSON.stringify(wanted),
  );
  const next = target && !target.disabled ? target : root.querySelector('#history-prompt, #prompt');
  next?.focus({ preventScroll: true });
  if (typeof next?.setSelectionRange === 'function' && Number.isInteger(saved.start))
    next.setSelectionRange(saved.start, saved.end);
}

function taskStatus(last) {
  const plan = last?.blocks.findLast((block) => block.kind === 'plan' && block.entries)?.entries;
  return plan
    ? `${plan.filter((entry) => entry.status === 'completed').length} of ${plan.length} tasks completed`
    : '';
}

function approvalStatus(approval) {
  return approval ? `Approval required: ${approval.title}` : '';
}

function statusText(state) {
  const last = state.turns.at(-1);
  const status = state.connecting
    ? 'Connecting'
    : state.busy
      ? 'Working'
      : state.connected
        ? 'Ready'
        : 'Disconnected';
  return [
    state.session,
    status,
    last && `Last turn ${last.status}`,
    `${state.changes.length} pending files`,
    taskStatus(last),
    `${state.queued?.length ?? 0} queued follow-ups${state.queuePaused ? ', paused' : ''}`,
    `${state.attachments?.length ?? 0} context attachments`,
    approvalStatus(state.approval),
  ]
    .filter(Boolean)
    .join('. ');
}

export function announcements(document) {
  const status = document.createElement('div');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const error = status.cloneNode();
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'assertive');
  document.body.append(status, error);
  return (state) => {
    const text = statusText(state);
    if (status.textContent !== text) status.textContent = text;
    if (error.textContent !== (state.error ?? '')) error.textContent = state.error ?? '';
  };
}
