import { activity, modelOutput, toolStatus } from './activity.js';
import { approvalCard } from './approvals.js';
import { questionCard, questionResults } from './questions.js';

const turnStatus = {
  running: { label: 'Running', icon: 'loading codicon-modifier-spin' },
  completed: { label: 'Completed', icon: 'pass' },
  cancelled: { label: 'Cancelled', icon: 'close' },
  failed: { label: 'Failed', icon: 'error' },
};

function promptEditor(ui) {
  const disabled = ui.disabled;
  return `<textarea id="history-prompt" aria-label="Edit Previous Prompt" ${disabled ? 'readonly' : ''}>${ui.escape(ui.editing.text)}</textarea><p class="history-note">Files and shared memory stay unchanged.</p><div class="edit-actions"><button type="button" class="text-button secondary" data-action="cancelEdit" ${ui.editing.pending ? 'disabled' : ''}>Cancel</button><button type="button" class="text-button secondary" data-action="applyEdit" ${disabled || !ui.canHistory || !ui.editing.text.trim() ? 'disabled' : ''}>${ui.icon('arrow-up')}Send</button></div>`;
}

function promptRow(current, ui) {
  const editor = ui.editing?.id === current.id;
  const prompt = editor ? promptEditor(ui) : ui.escape(current.prompt);
  const actions =
    ui.canHistory && current.history && !editor
      ? `<div class="prompt-actions">${ui.itemButton('edit', 'edit', 'Edit and Continue', current.id, ui.disabled)}${ui.itemButton('forkBefore', 'repo-forked', 'Fork Before This Prompt', current.id, ui.disabled)}</div>`
      : '';
  return `<div class="prompt-row"><span class="role-label user-role">${ui.icon('comment')}You</span><div class="user-message ${editor ? 'editing' : ''}">${prompt}</div>${actions}</div>`;
}

function activityStats(details) {
  const counts = { passed: 0, failed: 0, cancelled: 0, running: 0 };
  for (const block of details) {
    if (block.kind === 'tool') counts[toolStatus(block).key] += 1;
  }
  return Object.entries(counts)
    .filter(([, count]) => count)
    .map(([key, count]) => `<span class="activity-stat ${key}">${count} ${key}</span>`)
    .join('');
}

function turnActivity(current, details, ui) {
  if (!details.length && current.status !== 'running') return '';
  const status = turnStatus[current.status] ?? turnStatus.completed;
  const seconds = Math.max(
    0,
    Math.round(((current.endedAt ?? Date.now()) - current.startedAt) / 1000),
  );
  const open = ui.expanded[current.id] ?? current.status === 'running';
  const steps = details.length
    ? `<span class="activity-count">${details.length} step${details.length === 1 ? '' : 's'}</span>`
    : '';
  const body = details.map((block) => activity(block, current, ui)).join('');
  return `<details class="activity status-${current.status}" data-disclosure="${ui.escape(current.id)}" data-activity-status="${current.status}" ${open ? 'open' : ''}><summary>${ui.icon(status.icon)}<span class="activity-label">${status.label}</span>${steps}<span class="activity-stats">${activityStats(details)}</span><span class="elapsed" title="Elapsed time">${seconds}s</span></summary><div class="activity-body">${body}</div></details>`;
}

function answerActions(current, answer, ui) {
  const copy = `<button type="button" class="answer-action" data-action="copyAnswer" data-id="${ui.escape(answer.id)}" aria-label="Copy Answer" title="Copy Answer">${ui.icon('copy')}<span>Copy</span></button>`;
  const fork =
    ui.canHistory && current.status === 'completed' && current.history?.afterEntryId
      ? ui.itemButton('forkAfter', 'repo-forked', 'Fork After This Answer', current.id, ui.disabled)
      : '';
  return `<div class="answer-actions">${copy}${fork}</div>`;
}

function answerBlock(current, answer, ui) {
  return `<div class="assistant-answer" role="group" aria-label="Assistant answer"><span class="role-label assistant-role">${ui.icon('comment-discussion')}Assistant</span>${modelOutput(answer, 'answer', ui)}${answerActions(current, answer, ui)}</div>`;
}

export function turn(current, ui) {
  const last = current.blocks.at(-1);
  const answer = current.status !== 'running' && last?.kind === 'text' ? last : undefined;
  const details = current.blocks.filter(
    (block) =>
      block !== answer && !(block.kind === 'plan' && block.entries && current === ui.turns.at(-1)),
  );
  return `<article class="turn" data-turn-id="${ui.escape(current.id)}">${promptRow(current, ui)}${turnActivity(current, details, ui)}${questionResults(current, ui)}${answer ? answerBlock(current, answer, ui) : ''}</article>`;
}

export function transcriptMarkup(state, ui) {
  const turns = state.turns.map((current) => turn(current, { ...ui, turns: state.turns })).join('');
  return `<section class="transcript" aria-label="Conversation">${turns}${approvalCard(state, ui, 'command')}${questionCard(state, ui)}${!state.workspace ? `<button class="text-button" data-action="openFolder">Open Folder</button>` : ''}</section>`;
}

export function transcriptSignature(state, wide) {
  // Turns are patched by id; everything else still needs a full surface render.
  const { turns, ...rest } = state;
  const plan = turns.at(-1)?.blocks.findLast((block) => block.kind === 'plan' && block.entries);
  return JSON.stringify([wide, rest, plan?.entries]);
}

export function turnSignature(current, expanded) {
  const opens = [current.id, ...current.blocks.map((block) => block.id)]
    .map((id) => (expanded[id] ? '1' : '0'))
    .join('');
  return `${JSON.stringify(current)}|${opens}`;
}

export function primeTurnCache(transcript, state, ui, cache) {
  cache.clear();
  const nodes = new Map(
    Array.from(transcript.children)
      .filter((child) => child.dataset.turnId)
      .map((child) => [child.dataset.turnId, child]),
  );
  for (const current of state.turns) {
    const node = nodes.get(current.id);
    if (node) cache.set(current.id, { signature: turnSignature(current, ui.expanded), node });
  }
}

function elementFrom(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return holder.firstElementChild;
}

function place(transcript, node, anchor) {
  if (anchor) transcript.insertBefore(node, anchor);
  else transcript.append(node);
}

function extrasAnchor(transcript) {
  return Array.from(transcript.children).find((child) => !child.dataset.turnId) ?? null;
}

function createTurnNode(transcript, current, state, ui, previous) {
  const previousNode = previous?.node?.isConnected === true ? previous.node : null;
  const next = elementFrom(turn(current, { ...ui, turns: state.turns }));
  if (previousNode) previousNode.replaceWith(next);
  else place(transcript, next, extrasAnchor(transcript));
  return next;
}

function reconcileTurn(transcript, current, state, ui, cache) {
  const signature = turnSignature(current, ui.expanded);
  const previous = cache.get(current.id);
  const reusable = previous?.signature === signature ? previous.node : undefined;
  const node = reusable?.isConnected
    ? reusable
    : createTurnNode(transcript, current, state, ui, previous);
  cache.set(current.id, { signature, node });
  return node;
}

function pruneTurns(cache, retained) {
  for (const [id, entry] of cache) {
    if (retained.has(id)) continue;
    entry.node.remove();
    cache.delete(id);
  }
}

function orderTurns(transcript, nodes) {
  const currentNodes = Array.from(transcript.children).filter((child) => child.dataset.turnId);
  if (!currentNodes.some((node, index) => node !== nodes[index])) return;
  const anchor = extrasAnchor(transcript);
  for (const node of nodes) place(transcript, node, anchor);
}

export function reconcileTurns(transcript, state, ui, cache) {
  const retained = new Set();
  const nodes = state.turns.map((current) => {
    retained.add(current.id);
    return reconcileTurn(transcript, current, state, ui, cache);
  });
  pruneTurns(cache, retained);
  orderTurns(transcript, nodes);
}
