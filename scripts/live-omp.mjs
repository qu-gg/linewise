#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { liveArguments, liveSettings } from './live-guard.mjs';

const limits = liveSettings();
const report = process.env.VS_OMP_LIVE_REPORT;
if (!report) throw new Error('A private live report is required.');

function capture(direction, line) {
  if (line.length > 65536) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const record = { direction, id: message.id, method: message.method };
  if (message.method === 'session/request_permission') {
    const call = message.params.toolCall;
    record.toolIdHash = createHash('sha256').update(call.toolCallId).digest('hex');
    record.toolIdLength = call.toolCallId.length;
    record.input = call.rawInput;
    record.options = message.params.options;
  } else if (message.method === 'terminal/create') {
    const { command, args, cwd, env } = message.params;
    record.terminal = { command, args, cwd, envNames: env?.map((entry) => entry.name) };
  } else if (message.error) record.error = message.error;
  else if (message.result?.outcome) record.outcome = message.result.outcome;
  else return;
  const bounded =
    JSON.stringify(record).length <= 12000
      ? record
      : { direction, id: message.id, method: message.method, truncated: true };
  appendFileSync(`${report}.wire.jsonl`, `${JSON.stringify(bounded)}\n`, { mode: 0o600 });
}

const args = await liveArguments(process.argv.slice(2), limits, process.env.VS_OMP_LIVE_USER_DATA);
const child = spawn(process.env.OMP_EXECUTABLE || 'omp', args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
  env: { ...process.env, ...(limits.transport === 'http' ? { PI_REQUEST_COMPRESSION: '0' } : {}) },
});
const kill = () => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      console.error('Live OMP cleanup failed.');
      process.exitCode = 1;
    }
  }
};
const deadline = setTimeout(kill, limits.runSeconds * 1000);
process.on('SIGTERM', kill);
process.on('SIGINT', kill);
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
createInterface({ input: process.stdin }).on('line', (line) => capture('host', line));
createInterface({ input: child.stdout }).on('line', (line) => capture('omp', line));
child.on('error', (error) => {
  console.error(error.message);
  clearTimeout(deadline);
  process.exitCode = 1;
});
child.on('close', (code) => {
  clearTimeout(deadline);
  process.exit(process.exitCode ?? code ?? 1);
});
