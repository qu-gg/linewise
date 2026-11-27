import { activity, modelOutput, outputMeta, toolStatus } from './activity.js';
import { approvalCard } from './approvals.js';
import { promptRow } from './prompt-card.js';
import { questionCard, questionResults } from './questions.js';

const turnStatus = {
  running: { label: 'Running' },
  completed: { label: 'Completed' },
  cancelled: { label: 'Cancelled' },
  failed: { label: 'Failed' },
};

export function transcriptUi({ escape, icon, itemButton, expanded, editing, state, working }) {
  return {
    escape,
    icon,
    itemButton,
    expanded,
    editing,
    state,
    working,
    disabled: working() || editing?.pending,
    canHistory: Boolean(state.canHistory),
  };
}

function activityCounts(details) {
  const counts = { passed: 0, failed: 0, cancelled: 0, running: 0 };
  for (const block of details) {
    if (block.kind === 'tool') counts[toolStatus(block).key] += 1;
  }
  return Object.entries(counts)
    .filter(([, count]) => count)
    .map(([key, count]) => `${count} ${key}`);
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function activityStepCount(steps) {
  return `${steps} step${steps === 1 ? '' : 's'}`;
}

function activityTiming(seconds) {
  if (seconds === 0) return { suffix: '', html: '' };
  const text = `in ${formatDuration(seconds)}`;
  return {
    suffix: ` ${text}`,
    html: ` <span class="elapsed" title="${seconds} seconds">${text}</span>`,
  };
}

function activityCountSuffix(counts) {
  return counts.length ? `; ${counts.join(', ')}` : '';
}

function activityOpen(expanded, current) {
  return expanded[current.id] ?? current.status === 'running';
}

function activityDiff(current, changes) {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const change of changes ?? []) {
    const operations = change.operations ?? [];
    if (operations.length !== 1 || operations[0].turnId !== current.id) continue;
    if (!Number.isFinite(change.added) || !Number.isFinite(change.removed)) continue;
    added += change.added;
    removed += change.removed;
    files += 1;
  }
  if (files === 0) return { suffix: '', html: '' };
  const text = `+${added} -${removed}`;
  return {
    suffix: ` ${text}`,
    html: ` <span class="activity-diff"><span class="added">+${added}</span> <span class="removed">-${removed}</span></span>`,
  };
}

function toolChainKey(block) {
  return `toolchain:${block.id}`;
}

function toolChain(blocks, current, ui) {
  const key = toolChainKey(blocks[0]);
  const open = ui.expanded[key] ?? true;
  const body = blocks.map((block) => activity(block, current, ui)).join('');
  return `<details class="tool-chain" data-disclosure="${ui.escape(key)}" ${open ? 'open' : ''}><summary>Finished with ${activityStepCount(blocks.length)}</summary><div class="tool-chain-body">${body}</div></details>`;
}

function activityBody(current, details, ui) {
  const content = [];
  let tools = [];
  const flush = () => {
    if (!tools.length) return;
    content.push(
      tools.length === 1 ? activity(tools[0], current, ui) : toolChain(tools, current, ui),
    );
    tools = [];
  };
  for (const block of details) {
    if (block.kind === 'tool') {
      tools.push(block);
      continue;
    }
    flush();
    content.push(activity(block, current, ui));
  }
  flush();
  return content.join('');
}

function turnActivity(current, details, ui) {
  if (!details.length && current.status !== 'running') return '';
  const status = turnStatus[current.status] ?? turnStatus.completed;
  const seconds = Math.max(
    0,
    Math.round(((current.endedAt ?? Date.now()) - current.startedAt) / 1000),
  );
  const timing = activityTiming(seconds);
  const diff = activityDiff(current, ui.state.changes);
  const count = activityStepCount(details.length);
  const counts = activityCounts(details);
  const label = `${status.label} ${count}${timing.suffix}${diff.suffix}${activityCountSuffix(counts)}`;
  const open = activityOpen(ui.expanded, current);
  const body = activityBody(current, details, ui);
  return `<details class="activity status-${current.status}" data-disclosure="${ui.escape(current.id)}" data-activity-status="${current.status}" ${open ? 'open' : ''}><summary aria-label="${label}"><span class="activity-label">${status.label}</span> <span class="activity-count">${count}</span>${timing.html}${diff.html}</summary><div class="activity-body">${body}</div></details>`;
}

function answerActions(current, answer, ui) {
  const copy = `<button type="button" class="answer-action" data-action="copyAnswer" data-id="${ui.escape(answer.id)}" aria-label="Copy Answer" title="Copy Answer">${ui.icon('copy')}</button>`;
  const fork =
    ui.canHistory && current.status === 'completed' && current.history?.afterEntryId
      ? ui.itemButton('forkAfter', 'repo-forked', 'Fork After This Answer', current.id, ui.disabled)
      : '';
  return `<div class="answer-actions">${copy}${fork}</div>`;
}

function answerBlock(current, answer, ui) {
  const footer = `<div class="answer-footer">${answerActions(current, answer, ui)}${outputMeta(answer, { ...ui, className: 'output-metadata answer-metadata' })}</div>`;
  return `<div class="assistant-answer" role="group" aria-label="Assistant answer">${modelOutput(answer, 'answer', { ...ui, showMetadata: false })}${footer}</div>`;
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

export function turnSignature(current, expanded, state) {
  const opens = [
    current.id,
    ...current.blocks.flatMap((block) => [
      block.id,
      ...(block.kind === 'tool' ? [toolChainKey(block)] : []),
    ]),
  ]
    .map((id) => (expanded[id] ? '1' : '0'))
    .join('');
  return `${JSON.stringify(current)}|${opens}|${activityDiff(current, state.changes).suffix}`;
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
    if (node)
      cache.set(current.id, { signature: turnSignature(current, ui.expanded, state), node });
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
  const signature = turnSignature(current, ui.expanded, state);
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
