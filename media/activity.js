import { markdown } from './markdown.js';
import { liveFor } from './terminal-stream.js';

export function modelOutput(block, className, { escape }) {
  const date = new Date(block.receivedAt ?? NaN);
  const timestamp = Number.isNaN(date.getTime())
    ? '<span>Timestamp not recorded</span>'
    : `<time datetime="${date.toISOString()}">${escape(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date))}</time>`;
  return `<div class="model-output ${className}" data-focus="${escape(block.id)}" tabindex="0" role="group" aria-label="Model output"><div class="markdown">${markdown(block.text)}</div><div class="output-metadata">${timestamp}<span>${escape(block.model ?? 'Model not recorded')}</span></div></div>`;
}

function thoughtActivity(block, current, { escape, icon, expanded }) {
  const thinking = current.status === 'running' && current.blocks.at(-1) === block;
  return `<details class="thought" data-disclosure="${escape(block.id)}" ${(expanded[block.id] ?? thinking) ? 'open' : ''}><summary>${icon(thinking ? 'loading codicon-modifier-spin' : 'lightbulb')}${thinking ? 'Thinking' : 'Thought'}</summary>${modelOutput(block, '', { escape })}</details>`;
}

function terminalBadges(live, running, icon) {
  const streaming = `<span class="terminal-live" ${live?.running ? '' : 'hidden'}>Live</span><span class="terminal-truncated" ${live?.truncated ? '' : 'hidden'}>Truncated</span>`;
  const controls = running
    ? `<button type="button" class="icon-button terminal-controls" data-action="terminals" aria-label="Stop or Reveal Owned Terminal" title="Owned Terminals">${icon('terminal')}</button>`
    : '';
  return `${streaming}${controls}`;
}

function terminalText(block, live, running) {
  if (live) return live.output || (live.running ? 'Running...' : 'No output.');
  return block.text || (running ? 'Running...' : 'No output.');
}

function terminalActivity(block, { escape, icon, itemButton, expanded }) {
  const running = !['completed', 'failed', 'cancelled'].includes(block.status);
  const live = running ? liveFor(block.id) : undefined;
  const command = escape(block.command ?? block.title);
  const label = running ? 'Running' : block.status === 'failed' ? 'Failed' : 'Ran';
  return `<details class="tool terminal-tool" data-terminal-block="${escape(block.id)}" data-disclosure="${escape(block.id)}" ${(expanded[block.id] ?? running) ? 'open' : ''}><summary>${icon('terminal')}<span class="terminal-label">${label} <code title="${command}">${command}</code></span><span class="show-output">Show</span></summary><div class="terminal-pane"><div class="terminal-heading">${icon('terminal')}<code>${command}</code>${terminalBadges(live, running, icon)}${itemButton('copyTool', 'copy', 'Copy Command Output', block.id)}</div><pre class="tool-output">${escape(terminalText(block, live, running))}</pre></div></details>`;
}

function toolActivity(block, { escape, icon, expanded }) {
  const status =
    block.status === 'failed' ? 'error' : block.status === 'completed' ? 'pass' : 'loading';
  return `<details class="tool" data-disclosure="${escape(block.id)}" ${expanded[block.id] ? 'open' : ''}><summary>${icon(status === 'loading' ? 'loading codicon-modifier-spin' : status)}<span>${escape(block.title ?? 'Tool')}</span></summary>${block.input ? `<pre class="command">${escape(block.input)}</pre>` : ''}${block.text ? `<pre class="tool-output">${escape(block.text)}</pre>` : ''}</details>`;
}

export function activity(block, current, ui) {
  if (block.kind === 'text') return modelOutput(block, 'progress', ui);
  if (block.kind === 'thought') return thoughtActivity(block, current, ui);
  if (block.kind === 'plan') return `<pre class="plan">${ui.escape(block.text)}</pre>`;
  return block.toolKind === 'execute' ? terminalActivity(block, ui) : toolActivity(block, ui);
}
