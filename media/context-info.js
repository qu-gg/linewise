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

const charactersPerToken = 4;
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function decodeRate(characters, decodeMs) {
  const tokensPerSecond = characters / charactersPerToken / (decodeMs / 1000);
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : undefined;
}

function firstTextDelay(sent, first) {
  if (!finiteNumber(sent) || sent < 0 || first < sent) return undefined;
  return Math.round(first - sent);
}

function observedThroughput(turn) {
  const stream = turn?.stream;
  if (!stream) return undefined;
  const first = stream.firstTextAt;
  const last = stream.lastTextAt;
  const characters = stream.characters;
  const decodeMs = stream.decodeMs;
  if (!finiteNumber(first) || !finiteNumber(last) || !(characters > 0) || !(decodeMs > 0))
    return undefined;
  const tokensPerSecond = decodeRate(characters, decodeMs);
  if (tokensPerSecond === undefined) return undefined;
  return {
    tokensPerSecond,
    ttftMs: firstTextDelay(stream.promptSentAt, first),
    stale: turn.status !== 'running',
  };
}

function duration(milliseconds) {
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(1)} s`;
}

function throughput(state, escape) {
  const turns = Array.isArray(state.turns) ? state.turns : [];
  const reading = observedThroughput(turns.at(-1));
  if (!reading) return '';
  const rate =
    reading.tokensPerSecond >= 100
      ? Math.round(reading.tokensPerSecond)
      : reading.tokensPerSecond.toFixed(1);
  const rateTitle = `Estimated from stream timing (characters / ${charactersPerToken}); not provider-reported.${reading.stale ? ' Last observed; not live.' : ''}`;
  const ttft =
    reading.ttftMs === undefined
      ? ''
      : `<div><dt>First text</dt><dd title="${escape('Measured from prompt send to the first text chunk.')}">${duration(reading.ttftMs)}</dd></div>`;
  const note = reading.stale
    ? '<p class="context-note" role="status">Last observed. Not live.</p>'
    : '';
  return `<dl class="context-throughput"><div><dt>Output speed</dt><dd title="${escape(rateTitle)}">~${rate} tok/s</dd></div>${ttft}</dl>${note}`;
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
  return `<section class="context-popover" role="dialog" aria-labelledby="context-title" tabindex="-1"><header><h2 id="context-title">Session Info</h2>${inspect}${button('closeContext', 'close', 'Close Session Info')}</header><dl class="session-cost"><dt>Session cost</dt><dd>${escape(sessionCost(state.context?.cost))}</dd></dl>${throughput(state, escape)}<h3>Context Window</h3>${usageNumbers(state.context)}<dl class="context-details">${configuration(state, escape)}<div><dt>Memory</dt><dd>${state.connected ? 'Local' : 'Disconnected'}</dd></div></dl>${compactControl(state, disabled, icon)}</section>`;
}
