import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PathGuard, ReviewJournal } from '../dist/review.js';
import { MutationBroker } from '../dist/mutations.js';
import { nativePlans } from './native-plans.mjs';

async function contents(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function scenarioCase(directory, connection, session, journal, scenario) {
  const source = join(directory, scenario.source ?? 'probe.txt');
  const destination = join(directory, scenario.destination ?? 'moved.txt');
  const before = scenario.before ?? 'before\n';
  await writeFile(source, before);
  if (scenario.second) await writeFile(join(directory, 'second.txt'), before);
  await rm(destination, { force: true });
  await connection.agent.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: `NATIVE_MUTATION_FIXTURE ${scenario.name}` }],
  });
  const context = JSON.parse(await readFile(join(directory, 'provider-context.json'), 'utf8'));
  const reply = context.messages.findLast((message) => message.role === 'toolResult');
  assert.ok(reply, 'The fixture must observe a tool result.');
  assert.equal(Boolean(reply.isError), Boolean(scenario.error), JSON.stringify(reply));
  assert.equal(await contents(source), scenario.after);
  assert.equal(await contents(destination), scenario.moved ?? null);
  assert.equal(
    journal.list().length,
    scenario.error ? 0 : 1 + Number(Boolean(scenario.second)),
    'Every native mutation must have exactly one paired host review record.',
  );
  for (const change of journal.list()) await journal.discard(change.id);
  assert.equal(await contents(source), before);
  if (scenario.second) assert.equal(await contents(join(directory, 'second.txt')), before);
  assert.equal(await contents(destination), null);
  console.log(
    `PASS: installed native ${scenario.name} ${scenario.error ? 'refuses without changes' : 'is journaled and Discard restores its preimages'}.`,
  );
}

async function applyJournal(journal, mutation) {
  if (mutation.op === 'read') return journal.inspect(mutation.path);
  if (mutation.op === 'write') {
    await journal.write(
      'native-owner',
      mutation.path,
      mutation.content,
      undefined,
      mutation.before,
    );
    return mutation.content;
  }
  if (mutation.op === 'delete')
    await journal.delete('native-owner', mutation.path, undefined, mutation.before);
  else
    await journal.move('native-owner', mutation.path, mutation.destination, undefined, {
      before: mutation.before,
      after: mutation.content,
    });
  return mutation.op === 'delete' ? '' : mutation.content;
}

export function nativeMutations(directory) {
  const journal = new ReviewJournal(
    {
      read: contents,
      replace: async (target, expected, content) => {
        assert.equal(await contents(target), expected);
        if (content === null) await rm(target);
        else await writeFile(target, content);
      },
    },
    new PathGuard([directory]),
    async () => false,
    async () => {},
  );
  let broker;
  return {
    async permission(request) {
      const once = request.options.find((option) => option.kind === 'allow_once');
      const input = request.toolCall.rawInput;
      const allowed =
        once &&
        input &&
        typeof input === 'object' &&
        (await broker?.permit(request.toolCall.toolCallId, input.input));
      return {
        outcome: allowed
          ? { outcome: 'selected', optionId: once.optionId }
          : { outcome: 'cancelled' },
      };
    },
    async run(connection, session) {
      try {
        await connection.agent.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'model',
          value: 'vs-omp-fixture/history',
        });
        for (const scenario of nativePlans) {
          broker = new MutationBroker(
            join(directory, 'private', 'mutations'),
            (mutation) => applyJournal(journal, mutation),
            new AbortController().signal,
          );
          await broker.start();
          try {
            await scenarioCase(directory, connection, session, journal, scenario);
          } finally {
            await broker.close();
          }
          broker = undefined;
        }
      } finally {
        await broker?.close();
      }
    },
  };
}
