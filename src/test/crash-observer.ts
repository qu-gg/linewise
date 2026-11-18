import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OmpClient } from '../acp.js';
import { StateStore } from '../state.js';
import type { HistoryOperation } from '../history.js';

interface Observation {
  armed: boolean;
  sourceId: string;
  client?: OmpClient;
  hit(point: string): void;
}

function observeClient(state: Observation) {
  const { start, fork, history, prompt, selectSession } = OmpClient.prototype;
  OmpClient.prototype.start = async function (options) {
    state.client = this;
    await start.call(this, options);
  };
  OmpClient.prototype.fork = async function () {
    const result = await fork.call(this);
    state.hit('archive');
    return result;
  };
  OmpClient.prototype.history = async function (
    this: OmpClient,
    operation: HistoryOperation = { action: 'inspect' },
    handle = this.sessionId,
  ) {
    if (operation.action === 'navigate') state.hit('navigation');
    const result = await history.call(this, operation, handle);
    if (operation.action === 'navigate') state.hit('navigated');
    return result;
  };
  OmpClient.prototype.prompt = async function (blocks) {
    const replacement = blocks[0]?.type === 'text' && blocks[0].text === 'CRASH_REPLACEMENT';
    if (replacement) state.hit('replacement');
    const result = await prompt.call(this, blocks);
    if (replacement) state.hit('submitted');
    return result;
  };
  OmpClient.prototype.selectSession = async function (handle) {
    await selectSession.call(this, handle);
    state.hit('fork-selected');
  };
}

function savePoint(store: StateStore, sourceId: string): string {
  const source = store.data.sessions.find((session) => session.id === sourceId);
  if (!source) return '';
  if (source.historyTransition) return 'intent';
  if (store.data.activeSessionId !== sourceId) return 'fork-save';
  if (source.turns.length === 1) return 'rewound';
  const last = source.turns.at(-1);
  return last?.prompt === 'CRASH_REPLACEMENT' && last.status === 'completed' ? 'final' : '';
}

function observeStore(state: Observation) {
  const save = StateStore.prototype.save;
  StateStore.prototype.save = async function () {
    const point = savePoint(this, state.sourceId);
    if (point === 'intent') state.hit('intent-before');
    if (point === 'rewound') state.hit('verified');
    await save.call(this);
    state.hit(point);
  };
}

export function observeCrashes(directory: string, stage: string): Observation {
  const state: Observation = {
    armed: false,
    sourceId: '',
    hit(point) {
      if (!state.armed || point !== stage) return;
      writeFileSync(
        path.join(directory, 'ready.json'),
        JSON.stringify({
          stage,
          host: process.pid,
          omp: Number(readFileSync(process.env.VS_OMP_FIXTURE_PID!, 'utf8')),
          provider: readFileSync(process.env.VS_OMP_FIXTURE_CONTEXT!, 'utf8'),
        }),
        { mode: 0o600 },
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error('Crash checkpoint must be terminated, never released');
    },
  };
  observeClient(state);
  observeStore(state);
  return state;
}
