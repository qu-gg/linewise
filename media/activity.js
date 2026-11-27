import { markdown } from './markdown.js';

const toolStates = {
  completed: { key: 'passed', label: 'Passed', icon: 'pass' },
  failed: { key: 'failed', label: 'Failed', icon: 'error' },
  cancelled: { key: 'cancelled', label: 'Cancelled', icon: 'close' },
};

export function toolStatus(block) {
  return (
    toolStates[block.status] ?? {
      key: 'running',
      label: 'Running',
      icon: 'loading codicon-modifier-spin',
    }
  );
}

function timestamp(block, escape) {
  const date = new Date(block.receivedAt ?? NaN);
  return Number.isNaN(date.getTime())
    ? '<span>Timestamp not recorded</span>'
    : `<time datetime="${date.toISOString()}">${escape(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date))}</time>`;
}

export function modelOutput(block, className, { escape }) {
  const label = className.split(' ').includes('answer') ? 'Assistant answer' : 'Model output';
  return `<div class="model-output ${className}" data-focus="${escape(block.id)}" tabindex="0" role="group" aria-label="${label}"><div class="markdown">${markdown(block.text)}</div><div class="output-metadata">${timestamp(block, escape)}<span>${escape(block.model ?? 'Model not recorded')}</span></div></div>`;
}

function thoughtActivity(block, current, { escape, icon, expanded }) {
  const thinking = current.status === 'running' && current.blocks.at(-1) === block;
  const label = thinking ? 'Thinking' : 'Thought';
  return `<details class="thought status-${thinking ? 'running' : 'passed'}" data-disclosure="${escape(block.id)}" ${(expanded[block.id] ?? thinking) ? 'open' : ''}><summary>${icon(thinking ? 'loading codicon-modifier-spin' : 'lightbulb')}<span class="thought-label">${label}</span>${thinking ? '<span class="tool-status running">In progress</span>' : ''}</summary>${modelOutput(block, '', { escape })}</details>`;
}

function failureLine(block, escape, icon) {
  if (block.status !== 'failed') return '';
  return `<div class="failure tool-failure" role="status">${icon('warning')}<span>${escape(block.toolName ?? block.title ?? 'Tool')} failed</span></div>`;
}

function terminalActivity(block, { escape, icon, itemButton, expanded }) {
  const status = toolStatus(block);
  const command = escape(block.command ?? block.title);
  const open = expanded[block.id] ?? status.key === 'running';
  const output = escape(block.text || (status.key === 'running' ? 'Running...' : 'No output.'));
  return `<details class="tool terminal-tool status-${status.key}" data-disclosure="${escape(block.id)}" data-tool-status="${status.key}" ${open ? 'open' : ''}><summary aria-label="Terminal ${status.label.toLowerCase()}: ${command}">${icon('terminal')}<span class="terminal-label"><span class="tool-name">Terminal</span><code title="${command}">${command}</code></span><span class="tool-status ${status.key}">${status.label}</span><span class="show-output">${open ? 'Hide' : 'Show'}</span></summary><div class="terminal-pane" data-terminal-tool="${escape(block.id)}"><div class="terminal-heading">${icon('terminal')}<code>${command}</code>${itemButton('copyTool', 'copy', 'Copy Command Output', block.id)}</div>${failureLine(block, escape, icon)}<pre class="tool-output">${output}</pre></div></details>`; // keep terminal-pane/tool-output stable for live output
}

function toolActivity(block, { escape, icon, expanded }) {
  const status = toolStatus(block);
  const name = escape(block.toolName ?? block.title ?? 'Tool');
  const command = block.command ?? block.input;
  const open = expanded[block.id] ?? status.key === 'running';
  return `<details class="tool status-${status.key}" data-disclosure="${escape(block.id)}" data-tool-status="${status.key}" ${open ? 'open' : ''}><summary aria-label="${name}: ${status.label}">${icon(status.icon)}<span class="tool-name">${name}</span><span class="tool-status ${status.key}">${status.label}</span><span class="show-output">${open ? 'Hide' : 'Show'}</span></summary>${failureLine(block, escape, icon)}${command ? `<pre class="command">${escape(command)}</pre>` : ''}${block.text ? `<pre class="tool-output">${escape(block.text)}</pre>` : ''}</details>`;
}

export function activity(block, current, ui) {
  if (block.kind === 'text') return modelOutput(block, 'progress', ui);
  if (block.kind === 'thought') return thoughtActivity(block, current, ui);
  if (block.kind === 'plan')
    return `<div class="plan-block" role="group" aria-label="Plan"><pre class="plan">${ui.escape(block.text)}</pre></div>`;
  return block.toolKind === 'execute' ? terminalActivity(block, ui) : toolActivity(block, ui);
}
