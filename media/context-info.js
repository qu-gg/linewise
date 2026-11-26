const tokens = (value) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export const usagePercentage = (usage) =>
  usage?.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : undefined;

function configuration(state, escape) {
  return ['model', 'thinking']
    .map((id) => {
      const config = state.configs.find((item) => item.id === id);
      if (!config) return '';
      const selected =
        config.label ?? config.options?.find((option) => option.value === config.value)?.name;
      const provider =
        id === 'model' && config.provider
          ? `<div><dt>Provider</dt><dd>${escape(config.provider)}</dd></div>`
          : '';
      return `${provider}<div><dt>${id === 'model' ? 'Model' : 'Thinking'}</dt><dd>${escape(selected ?? config.value)}</dd></div>`;
    })
    .join('');
}

function usageNumbers(usage) {
  const percent = usagePercentage(usage);
  return `<div class="context-numbers"><span>${usage ? `${tokens(usage.used)} / ${tokens(usage.size)} tokens` : 'Not reported yet'}</span><span>${percent === undefined ? '' : `${percent}%`}</span></div>${usageProgress(usage)}`;
}

function usageProgress(usage) {
  return `<progress class="context-progress" aria-label="Context window usage" max="${usage?.size ?? 1}" value="${Math.min(usage?.used ?? 0, usage?.size ?? 1)}"></progress>${usage?.stale ? '<p class="context-note" role="status">Last reported usage. Updates after the next model turn.</p>' : ''}`;
}

function sessionCost(cost) {
  return cost
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(cost.amount)} ${cost.currency}`
    : 'Not reported';
}

function compactControl(state, disabled, icon) {
  return `<button type="button" class="compact-button" data-action="compact" ${disabled || !state.canCompact ? 'disabled' : ''}>${icon(state.compacting ? 'loading codicon-modifier-spin' : 'collapse-all')}${state.compacting ? 'Compacting...' : 'Compact Conversation'}</button>`;
}

export function contextPanel(state, open, { escape, icon, button, working }) {
  if (!open) return '';
  const disabled = !state.connected || working() || state.compacting;
  const inspect = state.canInspectContext
    ? button('inspectContext', 'inspect', 'Inspect Full Context', disabled ? 'disabled' : '')
    : '';
  return `<section class="context-popover" role="dialog" aria-labelledby="context-title" tabindex="-1"><header><h2 id="context-title">Session Info</h2>${inspect}${button('closeContext', 'close', 'Close Session Info')}</header><dl class="session-cost"><dt>Session cost</dt><dd>${escape(sessionCost(state.context?.cost))}</dd></dl><h3>Context Window</h3>${usageNumbers(state.context)}<dl class="context-details">${configuration(state, escape)}<div><dt>Memory</dt><dd>${state.connected ? 'Local' : 'Disconnected'}</dd></div></dl>${compactControl(state, disabled, icon)}</section>`;
}
