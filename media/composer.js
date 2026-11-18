import { taskPanel } from './tasks.js';
import { approvalCard } from './approvals.js';

export function canSubmit(state, draft) {
  return Boolean(
    draft.trim() &&
    !state.connecting &&
    (!state.busy || (state.cancellable && (state.queued?.length ?? 0) < 5)),
  );
}

function configs(state, { escape, working }) {
  return state.configs
    .map(
      (config) =>
        `<select id="config-${escape(config.id)}" aria-label="${escape(config.name)}" title="${escape(config.name)}" data-config="${escape(config.id)}" ${working() ? 'disabled' : ''}>${config.options.map((option) => `<option value="${escape(option.value)}" ${option.value === config.value ? 'selected' : ''}>${escape(option.name)}</option>`).join('')}</select>`,
    )
    .join('');
}

function attachments(state, { button, itemButton, escape, icon, working }) {
  const snapshots = state.attachments ?? [];
  const add = button('attachContext', 'add', 'Add Context', working() ? 'disabled' : '');
  if (!snapshots.length)
    return `<div class="prompt-context">${add}<span class="workspace-tag" title="${escape(state.attachment ?? state.workspace)}">${icon(state.attachment ? 'file-code' : 'folder')}${escape(state.attachment ?? state.workspace ?? '')}</span></div>`;
  return `<div class="prompt-context">${add}<ul class="attachments" aria-label="Attached Context">${snapshots.map((snapshot) => `<li><button type="button" class="attachment-inspect" data-action="inspectAttachment" data-id="${escape(snapshot.id)}" title="${escape(snapshot.uri)}">${icon(snapshot.kind === 'diagnostics' ? 'warning' : 'file-code')}<span>${escape(snapshot.label)}</span></button>${itemButton('removeAttachment', 'close', `Remove ${snapshot.label}`, snapshot.id, working())}</li>`).join('')}</ul></div>`;
}

function sendButton(state, draft, { button, icon }) {
  const label = state.busy ? 'Queue Follow-up' : 'Send';
  const send = `<button class="icon-button send" type="submit" aria-label="${label}" title="${label}" ${canSubmit(state, draft) ? '' : 'disabled'}>${icon(state.busy ? 'add' : 'arrow-up')}</button>`;
  if (state.busy)
    return `${state.cancellable ? send : ''}${button('cancel', 'debug-stop', 'Stop')}`;
  return send;
}

function followUps(state, expanded, { button, itemButton, escape, icon }) {
  if (!state.queued?.length) return '';
  const key = `queue-${state.sessionId}`;
  return `<details class="follow-ups dock-section" aria-label="Queued Prompts" data-disclosure="${escape(key)}" ${expanded[key] !== false ? 'open' : ''}><summary><span>Queued Prompts (${state.queued.length})</span>${state.queuePaused ? '<span>Paused</span>' : ''}<span class="dock-actions">${state.queuePaused ? button('resumeQueue', 'play', 'Resume Follow-ups', state.busy || state.connecting ? 'disabled' : '') : ''}${button('clearQueue', 'clear-all', 'Clear Follow-ups')}</span></summary><ol>${state.queued.map((item) => `<li>${icon('comment')}<span class="queued-prompt" title="${escape(item.text)}">${escape(item.text)}</span>${itemButton('removeQueued', 'close', 'Remove Follow-up', item.id)}</li>`).join('')}</ol></details>`;
}

function sessionStatus(state, { escape, icon }) {
  const label = state.connecting ? 'Connecting' : state.connected ? state.host : 'Disconnected';
  return `<span class="host-status">${icon('vm')}${escape(label)}</span>${state.connected ? `<span class="memory-status" title="OMP local memory enabled">${icon('database')}Memory</span>` : ''}`;
}

function contextToggle({ percentage, icon }, contextOpen) {
  const percent = percentage();
  return `<button type="button" id="context-toggle" class="context-toggle icon-button" data-action="context" aria-label="Session Context" aria-expanded="${contextOpen}" title="${percent === undefined ? 'Session context' : `${percent}% context used`}">${icon('pie-chart')}${percent === undefined ? '' : `<span>${percent}%</span>`}</button>`;
}

export function composer(state, draft, ui) {
  const {
    button,
    escape,
    icon,
    working,
    changesPanel,
    permissions,
    contextPanel,
    contextOpen,
    expanded,
  } = ui;
  return `<footer><div class="chat-dock"><div class="dock-sections">${followUps(state, expanded, ui)}${taskPanel(state, expanded, ui)}${changesPanel()}</div>${approvalCard(state, ui, 'file')}<form id="composer">${attachments(state, ui)}<textarea id="prompt" rows="2" aria-label="Message OMP" placeholder="Describe what to build">${escape(draft)}</textarea><div class="composer-tools"><span class="model-icon">${icon('copilot')}</span><div class="config-controls">${configs(state, ui)}</div>${sendButton(state, draft, ui)}</div></form></div><div class="statusbar">${sessionStatus(state, ui)}${permissions(state, working(), icon)}<span class="status-spacer"></span>${button('compact', 'collapse-all', 'Compact Context Now', !state.connected || !state.canCompact || working() ? 'disabled' : '')}${contextToggle(ui, contextOpen)}${contextPanel()}</div></footer>`;
}
