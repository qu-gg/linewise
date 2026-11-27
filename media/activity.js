import { markdown } from './markdown.js';
import { liveFor } from './terminal-stream.js';

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

function toolTarget(block) {
  if (block.command) return block.command;
  if (!block.input) return '';
  try {
    const input = JSON.parse(block.input);
    for (const field of ['path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'command']) {
      if (input[field] != null) return input[field];
    }
    return '';
  } catch {
    return block.input;
  }
}

function toolVisual(block) {
  const name = block.toolName ?? block.title ?? 'Tool';
  const kind = block.toolKind === 'execute' ? 'execute' : name.toLowerCase();
  if (kind === 'execute' || /bash|terminal|shell/.test(kind))
    return { icon: 'terminal', action: 'Ran', target: block.command };
  if (/read|open|view/.test(kind))
    return { icon: 'file', action: 'Read', target: toolTarget(block) };
  if (/search|grep|glob|find/.test(kind))
    return { icon: 'search', action: 'Searched', target: toolTarget(block) };
  if (/edit|write|rename|notebook|code_action/.test(kind))
    return { icon: 'edit', action: 'Edited', target: toolTarget(block) };
  if (/fetch|browser|web/.test(kind))
    return { icon: 'globe', action: 'Fetched', target: toolTarget(block) };
  return { icon: 'tools', action: name, target: toolTarget(block) };
}

function timestamp(block, escape) {
  const date = new Date(block.receivedAt ?? NaN);
  if (Number.isNaN(date.getTime())) return '<span>Timestamp not recorded</span>';
  const day = 86_400_000;
  const delta = Date.now() - date.getTime();
  let label;
  if (Math.abs(delta) < day)
    label = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  else if (Math.abs(delta) < 7 * day)
    label = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
      -Math.round(delta / day),
      'day',
    );
  else label = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  return `<time datetime="${date.toISOString()}">${escape(label)}</time>`;
}

export function outputMeta(block, { escape, className = 'output-metadata' }) {
  return `<div class="${className}">${timestamp(block, escape)}<span>${escape(block.model ?? 'Model not recorded')}</span></div>`;
}

export function modelOutput(block, className, { escape, showMetadata = true }) {
  const label = className.split(' ').includes('answer') ? 'Assistant answer' : 'Model output';
  return `<div class="model-output ${className}" data-focus="${escape(block.id)}" tabindex="0" role="group" aria-label="${label}"><div class="markdown">${markdown(block.text)}</div>${showMetadata ? outputMeta(block, { escape }) : ''}</div>`;
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

function toolSummary(visual, status, { escape, icon }) {
  const target = visual.target
    ? `<code class="tool-target" title="${escape(visual.target)}">${escape(visual.target)}</code>`
    : '';
  const state = `<span class="tool-status ${status.key}"${status.key === 'passed' ? ' hidden' : ''}>${status.label}</span>`;
  const label = `${visual.action}${visual.target ? ` ${visual.target}` : ''}: ${status.label}`;
  return `<summary aria-label="${escape(label)}">${icon(visual.icon)}<span class="tool-action">${escape(visual.action)}</span>${target}${state}</summary>`;
}

function terminalActivity(block, { escape, icon, itemButton, expanded }) {
  const status = toolStatus(block);
  const visual = toolVisual(block);
  const running = status.key === 'running';
  const live = running ? liveFor(block.id) : undefined;
  const command = escape(block.command ?? block.title ?? '');
  const open = expanded[block.id] ?? running;
  const output = escape(terminalText(block, live, running));
  return `<details class="tool terminal-tool status-${status.key}" data-terminal-block="${escape(block.id)}" data-tool-icon="${visual.icon}" data-disclosure="${escape(block.id)}" data-tool-status="${status.key}" ${open ? 'open' : ''}>${toolSummary(visual, status, { escape, icon })}<div class="terminal-pane" data-terminal-tool="${escape(block.id)}"><div class="terminal-heading">${icon('terminal')}<code>${command}</code>${terminalBadges(live, running, icon)}${itemButton('copyTool', 'copy', 'Copy Command Output', block.id)}</div>${failureLine(block, escape, icon)}<pre class="tool-output">${output}</pre></div></details>`; // keep terminal-pane/tool-output stable for live output
}

function toolActivity(block, { escape, icon, expanded }) {
  const status = toolStatus(block);
  const visual = toolVisual(block);
  const command = block.command ?? block.input;
  const open = expanded[block.id] ?? status.key === 'running';
  return `<details class="tool status-${status.key}" data-tool-icon="${visual.icon}" data-disclosure="${escape(block.id)}" data-tool-status="${status.key}" ${open ? 'open' : ''}>${toolSummary(visual, status, { escape, icon })}${failureLine(block, escape, icon)}${command ? `<pre class="command">${escape(command)}</pre>` : ''}${block.text ? `<pre class="tool-output">${escape(block.text)}</pre>` : ''}</details>`;
}

export function activity(block, current, ui) {
  if (block.kind === 'text') return modelOutput(block, 'progress', ui);
  if (block.kind === 'thought') return thoughtActivity(block, current, ui);
  if (block.kind === 'plan')
    return `<div class="plan-block" role="group" aria-label="Plan"><pre class="plan">${ui.escape(block.text)}</pre></div>`;
  return block.toolKind === 'execute' ? terminalActivity(block, ui) : toolActivity(block, ui);
}
