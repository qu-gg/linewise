import type { SessionNotification } from '@agentclientprotocol/sdk';
import { stripVTControlCharacters } from 'node:util';
import { appendChunk } from './state.js';
import type { ChatBlock, Turn } from './state.js';

export function updateTurn(
  current: Turn,
  update: SessionNotification['update'],
  commands: readonly string[],
  model?: string,
): void {
  if (
    (update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk') &&
    update.content.type === 'text'
  ) {
    appendChunk(
      current,
      update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'text',
      stripVTControlCharacters(update.content.text),
      update.messageId ?? undefined,
      { model: outputModel(current.prompt, commands, model) },
    );
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    updateTool(current, update);
  } else if (update.sessionUpdate === 'plan') {
    updatePlan(current, update);
  }
}

function outputModel(prompt: string, commands: readonly string[], model?: string) {
  const command = prompt.trim().split(/\s+/)[0] ?? '';
  return command.startsWith('/') && commands.includes(command.slice(1)) ? undefined : model;
}

function updatePlan(
  current: Turn,
  update: Extract<SessionNotification['update'], { sessionUpdate: 'plan' }>,
) {
  const entries = update.entries
    .slice(0, 100)
    .map(({ content, status }) => ({ content: content.slice(0, 2048), status }));
  const block: ChatBlock = {
    id: 'plan',
    kind: 'plan',
    text: entries.map((entry) => `${entry.status}: ${entry.content}`).join('\n'),
    entries,
  };
  const previous = current.blocks.findIndex((candidate) => candidate.id === 'plan');
  if (previous < 0) current.blocks.push(block);
  else current.blocks[previous] = block;
}

function updateTool(
  current: Turn,
  update: Extract<
    SessionNotification['update'],
    { sessionUpdate: 'tool_call' | 'tool_call_update' }
  >,
) {
  let block = current.blocks.find((candidate) => candidate.id === update.toolCallId);
  if (!block) {
    block = { id: update.toolCallId, kind: 'tool', text: '' };
    current.blocks.push(block);
  }
  block.title = update.title ?? block.title ?? update.name ?? 'Tool';
  block.status = update.status ?? block.status ?? 'in_progress';
  block.toolKind = update.kind ?? block.toolKind;
  toolInput(block, update.rawInput);
  if (update.content)
    block.text = update.content
      .flatMap((item) =>
        item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [],
      )
      .join('\n')
      .slice(0, 16_000);
}

function toolInput(block: ChatBlock, input: unknown) {
  if (
    typeof input === 'object' &&
    input !== null &&
    'command' in input &&
    typeof input.command === 'string'
  )
    block.command = input.command.slice(0, 16_000);
  if (input !== undefined) block.input = JSON.stringify(input, null, 2).slice(0, 16_000);
}
