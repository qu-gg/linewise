const streams = new Map();
const owners = new Map();
let turns = [];
let liveEnabled = true;

function finished(block) {
  return ['completed', 'failed', 'cancelled'].includes(block.status);
}

function runningBlock(turnId, blockId) {
  const turn = turns.find((candidate) => candidate.id === turnId);
  return turn?.blocks.find(
    (block) => block.id === blockId && block.kind === 'tool' && !finished(block) && !block.text,
  );
}

function prune() {
  if (!liveEnabled) {
    streams.clear();
    owners.clear();
    return;
  }
  for (const [terminalId, entry] of streams) {
    if (runningBlock(entry.turnId, entry.blockId)) continue;
    streams.delete(terminalId);
    if (owners.get(entry.blockId) === terminalId) owners.delete(entry.blockId);
  }
}

function paneFor(blockId) {
  return [...document.querySelectorAll('[data-terminal-block]')].find(
    (candidate) => candidate.dataset.terminalBlock === blockId,
  );
}

function apply(entry) {
  const pane = paneFor(entry.blockId);
  const output = pane?.querySelector('.tool-output');
  if (!output) return;
  const follow = output.scrollHeight - output.scrollTop - output.clientHeight <= 2;
  output.textContent = entry.output || (entry.running ? 'Running...' : 'No output.');
  if (follow) output.scrollTop = output.scrollHeight;
  for (const badge of pane.querySelectorAll('.terminal-live')) badge.hidden = !entry.running;
  for (const badge of pane.querySelectorAll('.terminal-truncated')) badge.hidden = !entry.truncated;
}

function entryFrom(data) {
  const text = ['terminalId', 'turnId', 'blockId', 'command', 'output'];
  if (text.some((field) => typeof data[field] !== 'string')) return;
  if (data.output.length > 262_144) return;
  if (typeof data.truncated !== 'boolean' || typeof data.running !== 'boolean') return;
  return {
    terminalId: data.terminalId,
    turnId: data.turnId,
    blockId: data.blockId,
    command: data.command,
    output: data.output,
    truncated: data.truncated,
    running: data.running,
  };
}

function accept(data) {
  const entry = entryFrom(data);
  if (!liveEnabled || !entry || !runningBlock(entry.turnId, entry.blockId)) return;
  streams.set(entry.terminalId, entry);
  owners.set(entry.blockId, entry.terminalId);
  apply(entry);
}

function replaceState(state) {
  liveEnabled = state?.connected !== false && state?.busy !== false;
  turns = Array.isArray(state?.turns)
    ? state.turns.filter((turn) => Array.isArray(turn?.blocks))
    : [];
  prune();
}

export function liveFor(blockId) {
  const terminalId = owners.get(blockId);
  return terminalId === undefined ? undefined : streams.get(terminalId);
}

export function bindTerminalStream() {
  window.addEventListener('message', (event) => {
    if (event.data?.v !== 1) return;
    if (event.data.type === 'state') replaceState(event.data.state);
    else if (event.data.type === 'terminalStream') accept(event.data);
  });
}

// The activity renderer imports this module; binding here keeps main.js within its line budget.
bindTerminalStream();
