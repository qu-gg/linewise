import { activity, modelOutput, outputMeta, toolStatus, toolVisual } from './activity.js';
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

function operationMatches(operation, turnId) {
  return (
    operation.turnId === turnId &&
    Number.isFinite(operation.added) &&
    Number.isFinite(operation.removed)
  );
}

function operationTotals(change, turnId) {
  let added = 0;
  let removed = 0;
  let matched = false;
  for (const operation of change.operations ?? []) {
    if (!operationMatches(operation, turnId)) continue;
    added += operation.added;
    removed += operation.removed;
    matched = true;
  }
  return matched ? { added, removed } : undefined;
}

function singleOperationFallback(change, turnId) {
  const operations = change.operations ?? [];
  if (operations.length !== 1 || operations[0].turnId !== turnId) return undefined;
  if (!Number.isFinite(change.added) || !Number.isFinite(change.removed)) return undefined;
  return { added: change.added, removed: change.removed };
}

function operationStats(change, turnId) {
  return operationTotals(change, turnId) ?? singleOperationFallback(change, turnId);
}

function activityDiff(current, changes) {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const change of changes ?? []) {
    const stats = operationStats(change, current.id);
    if (!stats) continue;
    added += stats.added;
    removed += stats.removed;
    files += 1;
  }
  if (files === 0) return { suffix: '', html: '' };
  const text = `+${added} -${removed}`;
  return {
    suffix: ` ${text}`,
    html: ` <button type="button" class="activity-diff" data-action="showChanges" aria-label="View file changes, ${added} lines added, ${removed} lines deleted" title="View file changes"><span class="added">+${added}</span> <span class="removed">-${removed}</span></button>`,
  };
}

function toolChainKey(block) {
  return `toolchain:${block.id}`;
}

function baseName(target) {
  const value = String(target);
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function noteStatus(facts, status) {
  if (status.key === 'blocked') {
    facts.blocked += 1;
    return true;
  }
  if (status.key === 'failed') {
    facts.failed += 1;
    return true;
  }
  if (status.key === 'skipped') {
    facts.skipped += 1;
    return true;
  }
  if (status.key === 'denied') {
    facts.denied += 1;
    return true;
  }
  if (status.key === 'cancelled') {
    facts.cancelled += 1;
    return true;
  }
  if (status.key === 'running') {
    facts.unfinished += 1;
    return true;
  }
  return false;
}

function noteTool(facts, block) {
  const visual = toolVisual(block);
  if (visual.kind === 'edit' && visual.target) {
    facts.edits.add(visual.target);
    facts.editSteps += 1;
    return;
  }
  if (visual.kind === 'command') {
    facts.commands += 1;
    return;
  }
  if (visual.kind === 'read' && visual.target) {
    facts.reads.add(visual.target);
    facts.readSteps += 1;
    return;
  }
  if (visual.kind === 'search' && visual.target) {
    if (visual.searchKind === 'files') {
      facts.patterns.add(visual.target);
      facts.fileSearchSteps += 1;
    } else {
      facts.phrases.add(visual.target);
      facts.textSearchSteps += 1;
    }
    return;
  }
  facts.other += 1;
}

function toolChainFacts(blocks) {
  const facts = {
    edits: new Set(),
    editSteps: 0,
    commands: 0,
    reads: new Set(),
    readSteps: 0,
    phrases: new Set(),
    patterns: new Set(),
    textSearchSteps: 0,
    fileSearchSteps: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    denied: 0,
    cancelled: 0,
    unfinished: 0,
    other: 0,
  };
  for (const block of blocks) {
    const status = toolStatus(block);
    if (noteStatus(facts, status)) continue;
    noteTool(facts, block);
  }
  return facts;
}

function countLabel(count, singular, plural) {
  return count === 1 ? singular : plural.replace('{0}', String(count));
}

function addEditLabel(labels, facts) {
  if (facts.edits.size === 1)
    labels.push({ text: `Edited ${baseName([...facts.edits][0])}`, steps: facts.editSteps });
  else if (facts.edits.size > 1)
    labels.push({
      text: countLabel(facts.edits.size, 'Edited 1 file', 'Edited {0} files'),
      steps: facts.editSteps,
    });
}

function addCommandLabel(labels, facts) {
  if (facts.commands > 0)
    labels.push({
      text: countLabel(facts.commands, 'Ran 1 command', 'Ran {0} commands'),
      steps: facts.commands,
    });
}

function addReadLabel(labels, facts) {
  if (facts.reads.size === 1)
    labels.push({ text: `Read ${baseName([...facts.reads][0])}`, steps: facts.readSteps });
  else if (facts.reads.size > 1)
    labels.push({
      text: countLabel(facts.reads.size, 'Read 1 file', 'Read {0} files'),
      steps: facts.readSteps,
    });
}

function addPhraseLabel(labels, facts) {
  if (facts.phrases.size === 1)
    labels.push({ text: 'Searched for 1 phrase', steps: facts.textSearchSteps });
  else if (facts.phrases.size > 1)
    labels.push({
      text: countLabel(facts.phrases.size, 'Searched for 1 phrase', 'Searched for {0} phrases'),
      steps: facts.textSearchSteps,
    });
}

function addPatternLabel(labels, facts) {
  if (facts.patterns.size === 1)
    labels.push({ text: 'Searched for 1 file pattern', steps: facts.fileSearchSteps });
  else if (facts.patterns.size > 1)
    labels.push({
      text: countLabel(
        facts.patterns.size,
        'Searched for 1 file pattern',
        'Searched for {0} file patterns',
      ),
      steps: facts.fileSearchSteps,
    });
}

function addOutcomeLabel(labels, count, singular, plural) {
  if (count > 0) labels.push({ text: countLabel(count, singular, plural), steps: count });
}

function toolChainLabels(facts) {
  const labels = [];
  addEditLabel(labels, facts);
  addCommandLabel(labels, facts);
  addReadLabel(labels, facts);
  addPhraseLabel(labels, facts);
  addPatternLabel(labels, facts);
  addOutcomeLabel(labels, facts.blocked, '1 tool call blocked', '{0} tool calls blocked');
  addOutcomeLabel(labels, facts.failed, '1 tool call failed', '{0} tool calls failed');
  addOutcomeLabel(labels, facts.skipped, '1 tool call skipped', '{0} tool calls skipped');
  addOutcomeLabel(labels, facts.denied, '1 tool call denied', '{0} tool calls denied');
  addOutcomeLabel(labels, facts.cancelled, '1 tool call cancelled', '{0} tool calls cancelled');
  addOutcomeLabel(labels, facts.unfinished, '1 unfinished tool call', '{0} unfinished tool calls');
  return labels;
}

function toolChainSummary(blocks) {
  const facts = toolChainFacts(blocks);
  const labels = toolChainLabels(facts);
  if (labels.length === 0) return undefined;
  const visible = labels.slice(0, 3);
  const overflow = labels.slice(3).reduce((total, label) => total + label.steps, 0);
  const other = facts.other + overflow;
  if (other > 0)
    visible.push({
      text: countLabel(other, '1 other step', '{0} other steps'),
      steps: other,
    });
  return visible.map((label) => label.text).join(', ');
}

function toolChain(blocks, current, ui) {
  const key = toolChainKey(blocks[0]);
  const open = ui.expanded[key] ?? true;
  const summary = toolChainSummary(blocks) ?? `Finished with ${activityStepCount(blocks.length)}`;
  const body = blocks.map((block) => activity(block, current, ui)).join('');
  return `<details class="tool-chain" data-disclosure="${ui.escape(key)}" ${open ? 'open' : ''}><summary><span class="tool-chain-label" title="${ui.escape(summary)}">${ui.escape(summary)}</span></summary><div class="tool-chain-body">${body}</div></details>`;
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
