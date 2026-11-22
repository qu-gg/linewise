import assert from 'node:assert/strict';

function recordedBlock(block, index) {
  assert.ok(['text', 'tool', 'plan'].includes(block.kind));
  assert.equal(typeof block.text, 'string');
  assert.ok(block.text.length <= 8192);
  return {
    id: `recorded-block-${index}`,
    kind: block.kind,
    text: block.text,
    status: block.status === 'failed' ? 'failed' : 'completed',
    title: typeof block.title === 'string' ? block.title.slice(0, 512) : undefined,
    toolKind: block.toolKind === 'execute' ? 'execute' : undefined,
  };
}

function recordedTurn(turn, index) {
  assert.equal(typeof turn.prompt, 'string');
  assert.ok(turn.prompt.length <= 64000);
  assert.ok(Array.isArray(turn.blocks) && turn.blocks.length <= 100);
  return {
    id: `recorded-turn-${index}`,
    prompt: turn.prompt,
    status: turn.status === 'cancelled' ? 'cancelled' : 'completed',
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    blocks: turn.blocks.filter((block) => block.kind !== 'thought').map(recordedBlock),
  };
}

export function recordedFixture(fixture, turns) {
  assert.ok(Array.isArray(turns) && turns.length > 0 && turns.length <= 40);
  return {
    ...fixture,
    busy: false,
    cancellable: false,
    host: 'Replay',
    workspace: 'Disposable test fixture',
    session: 'Recorded test conversation',
    canHistory: false,
    canCompact: false,
    canInspectContext: false,
    context: undefined,
    attachments: [],
    queued: [],
    approval: undefined,
    approvalCount: 0,
    changes: [],
    configs: [],
    turns: turns.map(recordedTurn),
  };
}

export function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
