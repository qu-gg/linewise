import { toolbar } from './toolbar.js';
import { bindPermissions, permissionControl, togglePermissions } from './permissions.js';
import { changesPanel as reviewPanel, reviewRequest } from './review.js';
import { canSubmit, composer } from './composer.js';
import {
  announcements,
  captureFocus,
  restoreFocus,
  settleAttentionFocus,
} from './accessibility.js';
import { approvalCard, bindApprovals, refreshApproval } from './approvals.js';
import { questionCard, questionResults, bindQuestions } from './questions.js';
import {
  bindSessions,
  isWide,
  managerState,
  sessionManager,
  sessionSidebar,
  showSessions,
} from './sessions.js';
import {
  chatFrame,
  followTranscript,
  removeChatSurface,
  restoreTranscript,
  statusBanner,
  watchLayout,
} from './layout.js';
import { contextPanel as sessionInfo, usagePercentage } from './context-info.js';
import { activity, modelOutput } from './activity.js';
import { pasteImages } from './clipboard.js';
import * as picker from './model-picker.js';
const vscode = acquireVsCodeApi();
const remembered = vscode.getState() ?? {};
const expanded = remembered.expanded ?? {};
let state = { turns: [], changes: [], configs: [] };
let draft = remembered.draft ?? '';
const drafts = remembered.drafts ?? {};
let draftSession = remembered.sessionId;
let editing = remembered.editing ?? null;
let pendingRender = false;
let activeThoughts = new Set();
let contextOpen = false;
let notice = '';
const app = document.querySelector('#app');
const announce = announcements(document);
const escape = (text) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const icon = (name) => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
const working = () => state.busy || state.connecting;
const itemButton = (action, name, label, id, disabled = false) =>
  button(action, name, label, `data-id="${escape(id)}" ${disabled ? 'disabled' : ''}`);
function button(action, name, label, extra = '') {
  const blocked =
    (action === 'cancel' && state.cancellable === false) ||
    (['keep', 'discard'].includes(action) && working()) ||
    (action === 'disconnect' && state.busy && state.cancellable === false);
  return `<button type="button" class="icon-button" data-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${blocked ? 'disabled' : ''} ${extra}>${icon(name)}</button>`;
}
const activityUi = { escape, icon, itemButton, expanded };
const send = (type, extra = {}) => vscode.postMessage({ v: 1, type, ...extra });
bindApprovals(send);
bindQuestions(send, render);
bindPermissions(send, render, () => state);
bindSessions(
  send,
  () => {
    remember();
    render();
  },
  () => state,
  remembered.sessions,
);
function promptEditor(disabled) {
  return `<textarea id="history-prompt" aria-label="Edit Previous Prompt" ${disabled ? 'readonly' : ''}>${escape(editing.text)}</textarea><p class="history-note">Files and shared memory stay unchanged.</p><div class="edit-actions"><button type="button" class="text-button secondary" data-action="cancelEdit" ${editing.pending ? 'disabled' : ''}>Cancel</button><button type="button" class="text-button secondary" data-action="applyEdit" ${disabled || !state.canHistory || !editing.text.trim() ? 'disabled' : ''}>${icon('arrow-up')}Send</button></div>`;
}

function promptRow(current) {
  const disabled = working() || editing?.pending;
  const editor = editing?.id === current.id;
  const prompt = editor ? promptEditor(disabled) : escape(current.prompt);
  const actions =
    state.canHistory && current.history && !editor
      ? `<div class="prompt-actions">${itemButton('edit', 'edit', 'Edit and Continue', current.id, disabled)}${itemButton('forkBefore', 'repo-forked', 'Fork Before This Prompt', current.id, disabled)}</div>`
      : '';
  return `<div class="prompt-row"><div class="user-message ${editor ? 'editing' : ''}">${prompt}</div>${actions}</div>`;
}

function turnActivity(current, details) {
  if (!details.length && current.status !== 'running') return '';
  const count = details.filter((block) => block.kind === 'tool').length;
  const seconds = Math.max(
    0,
    Math.round(((current.endedAt ?? Date.now()) - current.startedAt) / 1000),
  );
  const label = {
    running: 'Working',
    completed: 'Completed',
    cancelled: 'Cancelled',
    failed: 'Failed',
  }[current.status];
  const open = expanded[current.id] ?? current.status === 'running';
  return `<details class="activity" data-disclosure="${escape(current.id)}" ${open ? 'open' : ''}><summary><span>${label}${count ? ` ${count} step${count === 1 ? '' : 's'}` : ''} <span class="elapsed">${seconds}s</span></span></summary><div class="activity-body">${details.map((block) => activity(block, current, activityUi)).join('')}</div></details>`;
}

function afterAnswer(current) {
  if (!state.canHistory || current.status !== 'completed' || !current.history?.afterEntryId)
    return '';
  const disabled = working() || editing?.pending;
  return `<div class="answer-actions">${itemButton('forkAfter', 'repo-forked', 'Fork After This Answer', current.id, disabled)}</div>`;
}

function turn(current) {
  const last = current.blocks.at(-1);
  const answer = current.status !== 'running' && last?.kind === 'text' ? last : undefined;
  const details = current.blocks.filter(
    (block) =>
      block !== answer &&
      !(block.kind === 'plan' && block.entries && current === state.turns.at(-1)),
  );
  const failures = details.filter((block) => block.kind === 'tool' && block.status === 'failed');
  return `<article class="turn">${promptRow(current)}${turnActivity(current, details)}${questionResults(current, { escape, icon })}${failures.map((block) => `<div class="failure" role="status">${icon('warning')}${escape(block.title)} failed</div>`).join('')}${answer ? modelOutput(answer, 'answer', activityUi) : ''}${afterAnswer(current)}</article>`;
}

const percentage = () => usagePercentage(state.context);

function contextPanel() {
  return sessionInfo(state, contextOpen, { escape, icon, button, working });
}

function changesPanel() {
  return reviewPanel(state, expanded, { escape, icon, button, itemButton });
}

function render() {
  const oldTranscript = document.querySelector('.transcript');
  const follow = followTranscript(oldTranscript);
  const scroll = oldTranscript?.scrollTop ?? 0;
  const dockScroll = document.querySelector('.dock-sections')?.scrollTop ?? 0;
  const focused = captureFocus(app);
  const hasDraft = (id) => Boolean((draftSession === id ? draft : drafts[id])?.trim());
  const ui = { escape, icon, button, hasDraft };
  const wide = isWide();
  const manager = wide ? '' : sessionManager(state, ui);
  const sidebar = wide ? sessionSidebar(state, ui) : '';
  const header = toolbar(state, button, escape);
  const banner = statusBanner(state.error || notice, icon, escape);
  const transcriptMarkup = `<section class="transcript" aria-label="Conversation">${state.turns.map(turn).join('')}${approvalCard(state, { escape, icon }, 'command')}${questionCard(state, { escape, icon })}${!state.workspace ? '<button class="text-button" data-action="openFolder">Open Folder</button>' : ''}</section>`;
  const footer = composer(state, draft, {
    button,
    itemButton,
    escape,
    icon,
    working,
    changesPanel,
    permissions: permissionControl,
    contextPanel,
    contextOpen,
    percentage,
    expanded,
  });
  app.innerHTML = chatFrame({
    wide,
    header,
    banner,
    manager,
    sidebar,
    transcript: transcriptMarkup,
    footer,
  });
  const transcript = document.querySelector('.transcript');
  if (manager) {
    removeChatSurface();
    restoreFocus(app, focused);
    announce(state);
    return;
  }
  restoreTranscript(transcript, follow, scroll, dockScroll);
  refreshApproval(app);
  picker.refreshModelPicker(app);
  restoreFocus(app, focused);
  announce(state);
}

watchLayout(render, remember);

function submit() {
  if (!canSubmit(state, draft)) return;
  notice = '';
  send(state.busy ? 'queuePrompt' : 'prompt', { text: draft });
  draft = '';
  remember();
  render();
}

function applyEdit() {
  if (!editing?.text.trim() || editing.pending || working() || !state.canHistory) return;
  editing.pending = true;
  send('editPrompt', { id: editing.id, text: editing.text });
  remember();
  render();
}

function remember() {
  vscode.setState({
    draft,
    drafts,
    sessionId: draftSession,
    editing,
    expanded,
    sessions: managerState(),
  });
}
app.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});
app.addEventListener('input', (event) => {
  if (event.target.id === 'history-prompt' && editing) {
    editing.text = event.target.value;
    remember();
    document.querySelector('[data-action="applyEdit"]').disabled =
      !editing.text.trim() || editing.pending || working() || !state.canHistory;
    return;
  }
  if (event.target.id !== 'prompt') return;
  draft = event.target.value;
  remember();
  const submitButton = document.querySelector('.send');
  if (submitButton) submitButton.disabled = !canSubmit(state, draft);
});
app.addEventListener('keydown', (event) => {
  if (
    event.target.id === 'history-prompt' &&
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    applyEdit();
  }
  if (
    event.target.id === 'prompt' &&
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    submit();
  }
});
app.addEventListener('change', (event) => {
  if (event.target.dataset.route) send('modelRoute', { value: event.target.value });
  else if (event.target.dataset.config)
    send('config', { id: event.target.dataset.config, value: event.target.value });
});
app.addEventListener(
  'paste',
  (event) =>
    void pasteImages(event, {
      working,
      setDraft: (value) => {
        draft = value;
      },
      setNotice: (value) => {
        notice = value;
      },
      canSubmit: (value) => canSubmit(state, value),
      send: (images) => send('pasteImages', { images }),
      remember,
      render,
      focus: () => document.querySelector('#prompt')?.focus({ preventScroll: true }),
    }),
);
function rememberDisclosure(summary, target) {
  if (summary?.parentElement.dataset.disclosure && !target) {
    const details = summary.parentElement;
    setTimeout(() => {
      expanded[details.dataset.disclosure] = details.open;
      remember();
    }, 0);
  }
}

function beginEdit(id) {
  const current = state.turns.find((candidate) => candidate.id === id);
  if (!current || working()) return;
  editing = { id: current.id, text: current.prompt, pending: false };
  remember();
  render();
  document.querySelector('#history-prompt')?.focus({ preventScroll: true });
}

function cancelEdit() {
  editing = null;
  remember();
  render();
  document.querySelector('#prompt')?.focus({ preventScroll: true });
}

function contextAction(action) {
  contextOpen = action === 'context' && !contextOpen;
  render();
  document
    .querySelector(contextOpen ? '.context-popover' : '#context-toggle')
    .focus({ preventScroll: true });
}

function offerAction(action, id) {
  send(action, { id });
  document.querySelector('#prompt')?.focus({ preventScroll: true });
}

function escapeOffer(event) {
  if (event.key !== 'Escape' || !event.target.closest?.('.context-offer') || working()) return;
  event.preventDefault();
  offerAction('dismissOffer', state.contextOffer.id);
}

function buttonAction(target) {
  const actions = {
    edit: () => beginEdit(target.dataset.id),
    cancelEdit,
    applyEdit,
    pickModel: () =>
      picker.modelPickerOpen()
        ? picker.closeModelPicker(render)
        : picker.openModelPicker(send, render),
    permissions: () => togglePermissions(render, () => state),
    forkBefore: () => send('forkTurn', { id: target.dataset.id, boundary: 'before' }),
    forkAfter: () => send('forkTurn', { id: target.dataset.id, boundary: 'after' }),
    context: () => contextAction('context'),
    closeContext: () => contextAction('closeContext'),
    attachOffer: () => offerAction('attachOffer', target.dataset.id),
    dismissOffer: () => offerAction('dismissOffer', target.dataset.id),
  };
  const handler = actions[target.dataset.action];
  if (handler) handler();
  else send(target.dataset.action, reviewRequest(target));
}

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  const summary = event.target.closest('summary');
  rememberDisclosure(summary, target);
  const link = event.target.closest('a');
  if (link) {
    event.preventDefault();
    send('link', { href: link.getAttribute('href') });
    return;
  }
  if (target) {
    if (target.disabled) return;
    if (summary) event.preventDefault();
    buttonAction(target);
  }
});
document.addEventListener('click', (event) => {
  if (contextOpen && !event.target.closest('.context-popover, .context-toggle')) {
    contextOpen = false;
    render();
  }
});
document.addEventListener('keydown', (event) => {
  escapeOffer(event);
  if (event.key === 'Escape' && editing && !editing.pending) {
    event.preventDefault();
    editing = null;
    remember();
    render();
    document.querySelector('#prompt')?.focus({ preventScroll: true });
  }
  if (event.key === 'Escape' && contextOpen) {
    event.preventDefault();
    contextOpen = false;
    render();
    document.querySelector('#context-toggle').focus({ preventScroll: true });
  }
});
function editResult(data) {
  if (editing?.id === data.id) {
    if (data.ok) editing = null;
    else {
      editing.pending = false;
      editing.id = data.turnId ?? editing.id;
    }
    remember();
    render();
  }
}

function switchDraft(incoming) {
  const owner = incoming.sessionId ?? 'new';
  if (owner === draftSession) return;
  if (draftSession) drafts[draftSession] = draft;
  const initialDraft = !draftSession || draftSession === 'new';
  draft = drafts[owner] ?? (initialDraft ? draft : '');
  if (draftSession === 'new') delete drafts.new;
  if (draftSession) editing = null;
  draftSession = owner;
}

function settleThoughts(turns) {
  const thinking = new Set(
    turns
      .filter(
        (current) => current.status === 'running' && current.blocks.at(-1)?.kind === 'thought',
      )
      .map((current) => current.blocks.at(-1).id),
  );
  for (const id of activeThoughts) if (!thinking.has(id)) expanded[id] = false;
  activeThoughts = thinking;
}

function pruneDrafts(ids) {
  if (!Array.isArray(ids)) return;
  const retained = new Set(ids);
  for (const id of Object.keys(drafts)) if (!retained.has(id)) delete drafts[id];
  if (draftSession && !retained.has(draftSession)) {
    draft = '';
    editing = null;
    draftSession = undefined;
  }
}

function receiveState(incoming) {
  pruneDrafts(incoming.sessionIds);
  switchDraft(incoming);
  settleThoughts(incoming.turns);
  remember();
  state = incoming;
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => {
    pendingRender = false;
    render();
  });
}

function focusTerminals(sessionId) {
  if (state.connected && state.busy && state.sessionId === sessionId)
    document
      .querySelector('[data-action="terminals"]:not(:disabled)')
      ?.focus({ preventScroll: true });
}

function focusAttention(event, nextFrame = true) {
  if (state.sessionId !== event.sessionId) return;
  const pending = event.kind === 'approval' ? state.approval : state.question;
  if (event.kind !== 'finished' && pending?.id !== event.id) return;
  if (managerState().open) {
    showSessions(false);
    render();
    remember();
  }
  const selector = {
    approval: '.approval-card',
    questions: '.question-card[data-question-id]',
    finished: '#prompt',
  }[event.kind];
  const target = document.querySelector(selector);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (nextFrame) settleAttentionFocus(app, () => focusAttention(event, false));
}

window.addEventListener('focus', () => send('focus', { focused: true }));
window.addEventListener('blur', () => send('focus', { focused: false }));
const messageActions = {
  editResult,
  draft: (data) => {
    draft = data.text;
    remember();
    render();
    document.querySelector('#prompt')?.focus({ preventScroll: true });
  },
  state: (data) => receiveState(data.state),
  focusTerminals: (data) => focusTerminals(data.sessionId),
  focusAttention,
  showSessions: () => {
    showSessions();
    render();
    remember();
    document.querySelector('#session-search')?.focus();
  },
};
window.addEventListener('message', (event) => {
  if (event.data?.v !== 1) return;
  if (Object.hasOwn(messageActions, event.data.type)) messageActions[event.data.type](event.data);
});
picker.bindModelPicker(send, render);
render();
send('ready');
send('focus', { focused: document.hasFocus() });
