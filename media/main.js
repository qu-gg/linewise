import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { permissions, toolbar } from './toolbar.js';
import { changesPanel as reviewPanel, reviewRequest } from './review.js';
import { canSubmit, composer } from './composer.js';
import { announcements, captureFocus, restoreFocus } from './accessibility.js';
import { approvalCard, bindApprovals, refreshApproval } from './approvals.js';
import { contextPanel as sessionInfo, usagePercentage } from './context-info.js';

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
const markdown = (text) =>
  DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'hr',
      'pre',
      'code',
      'blockquote',
      'strong',
      'em',
      'del',
      'ul',
      'ol',
      'li',
      'a',
      'h1',
      'h2',
      'h3',
      'h4',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
const send = (type, extra = {}) => vscode.postMessage({ v: 1, type, ...extra });
bindApprovals(send);

function modelOutput(block, className = '') {
  const date = new Date(block.receivedAt ?? NaN);
  const timestamp = Number.isNaN(date.getTime())
    ? '<span>Timestamp not recorded</span>'
    : `<time datetime="${date.toISOString()}">${escape(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date))}</time>`;
  return `<div class="model-output ${className}" data-focus="${escape(block.id)}" tabindex="0" role="group" aria-label="Model output"><div class="markdown">${markdown(block.text)}</div><div class="output-metadata">${timestamp}<span>${escape(block.model ?? 'Model not recorded')}</span></div></div>`;
}

function thoughtActivity(block, current) {
  const thinking = current.status === 'running' && current.blocks.at(-1) === block;
  return `<details class="thought" data-disclosure="${escape(block.id)}" ${(expanded[block.id] ?? thinking) ? 'open' : ''}><summary>${icon(thinking ? 'loading codicon-modifier-spin' : 'lightbulb')}${thinking ? 'Thinking' : 'Thought'}</summary>${modelOutput(block)}</details>`;
}

function terminalActivity(block) {
  const running = !['completed', 'failed', 'cancelled'].includes(block.status);
  const command = escape(block.command ?? block.title);
  const label = running ? 'Running' : block.status === 'failed' ? 'Failed' : 'Ran';
  return `<details class="tool terminal-tool" data-disclosure="${escape(block.id)}" ${(expanded[block.id] ?? running) ? 'open' : ''}><summary>${icon('terminal')}<span class="terminal-label">${label} <code title="${command}">${command}</code></span><span class="show-output">Show</span></summary><div class="terminal-pane"><div class="terminal-heading">${icon('terminal')}<code>${command}</code>${itemButton('copyTool', 'copy', 'Copy Command Output', block.id)}</div><pre class="tool-output">${escape(block.text || (running ? 'Running...' : 'No output.'))}</pre></div></details>`;
}

function toolActivity(block) {
  const status =
    block.status === 'failed' ? 'error' : block.status === 'completed' ? 'pass' : 'loading';
  return `<details class="tool" data-disclosure="${escape(block.id)}" ${expanded[block.id] ? 'open' : ''}><summary>${icon(status === 'loading' ? 'loading codicon-modifier-spin' : status)}<span>${escape(block.title ?? 'Tool')}</span></summary>${block.input ? `<pre class="command">${escape(block.input)}</pre>` : ''}${block.text ? `<pre class="tool-output">${escape(block.text)}</pre>` : ''}</details>`;
}

function activity(block, current) {
  if (block.kind === 'text') return modelOutput(block, 'progress');
  if (block.kind === 'thought') return thoughtActivity(block, current);
  if (block.kind === 'plan') return `<pre class="plan">${escape(block.text)}</pre>`;
  return block.toolKind === 'execute' ? terminalActivity(block) : toolActivity(block);
}

function promptEditor(disabled) {
  return `<textarea id="history-prompt" aria-label="Edit Previous Prompt" ${disabled ? 'readonly' : ''}>${escape(editing.text)}</textarea><p class="history-note">Files and shared memory stay unchanged.</p><div class="edit-actions"><button type="button" class="text-button secondary" data-action="cancelEdit" ${editing.pending ? 'disabled' : ''}>Cancel</button><button type="button" class="text-button" data-action="applyEdit" ${disabled || !state.canHistory || !editing.text.trim() ? 'disabled' : ''}>${icon('arrow-up')}Send</button></div>`;
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
  return `<details class="activity" data-disclosure="${escape(current.id)}" ${open ? 'open' : ''}><summary><span>${label}${count ? ` ${count} step${count === 1 ? '' : 's'}` : ''} <span class="elapsed">${seconds}s</span></span></summary><div class="activity-body">${details.map((block) => activity(block, current)).join('')}</div></details>`;
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
  return `<article class="turn">${promptRow(current)}${turnActivity(current, details)}${failures.map((block) => `<div class="failure" role="status">${icon('warning')}${escape(block.title)} failed</div>`).join('')}${answer ? modelOutput(answer, 'answer') : ''}${afterAnswer(current)}</article>`;
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
  const follow =
    !oldTranscript ||
    oldTranscript.scrollHeight - oldTranscript.scrollTop - oldTranscript.clientHeight < 60;
  const scroll = oldTranscript?.scrollTop ?? 0;
  const dockScroll = document.querySelector('.dock-sections')?.scrollTop ?? 0;
  const focused = captureFocus(app);
  app.innerHTML = `${toolbar(state, button, escape)}
    ${state.error ? `<div class="attention">${icon('warning')}<span>${escape(state.error)}</span></div>` : ''}
    <section class="transcript" aria-label="Conversation">${state.turns.map(turn).join('')}${approvalCard(state, { escape, icon }, 'command')}${!state.workspace ? '<button class="text-button" data-action="openFolder">Open Folder</button>' : ''}</section>
    ${composer(state, draft, { button, itemButton, escape, icon, working, changesPanel, permissions, contextPanel, contextOpen, percentage, expanded })}`;
  const transcript = document.querySelector('.transcript');
  transcript.scrollTop = follow ? transcript.scrollHeight : scroll;
  document.querySelector('.dock-sections').scrollTop = dockScroll;
  refreshApproval(app);
  restoreFocus(app, focused);
  announce(state);
}

function submit() {
  if (!canSubmit(state, draft)) return;
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
  vscode.setState({ draft, drafts, sessionId: draftSession, editing, expanded });
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
  if (event.target.dataset.config)
    send('config', { id: event.target.dataset.config, value: event.target.value });
});
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

function buttonAction(target) {
  const actions = {
    edit: () => beginEdit(target.dataset.id),
    cancelEdit,
    applyEdit,
    forkBefore: () => send('forkTurn', { id: target.dataset.id, boundary: 'before' }),
    forkAfter: () => send('forkTurn', { id: target.dataset.id, boundary: 'after' }),
    context: () => contextAction('context'),
    closeContext: () => contextAction('closeContext'),
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
  if (incoming.sessionId && incoming.sessionId !== draftSession) {
    if (draftSession) drafts[draftSession] = draft;
    draft = drafts[incoming.sessionId] ?? (draftSession ? '' : draft);
    if (draftSession) editing = null;
    draftSession = incoming.sessionId;
  }
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

window.addEventListener('message', (event) => {
  if (event.data?.v !== 1) return;
  switch (event.data.type) {
    case 'editResult':
      editResult(event.data);
      break;
    case 'draft':
      draft = event.data.text;
      remember();
      render();
      document.querySelector('#prompt')?.focus({ preventScroll: true });
      break;
    case 'state':
      receiveState(event.data.state);
      break;
  }
});
render();
send('ready');
