import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const blockSchema = z.object({
  kind: z.enum(['text', 'tool', 'plan']),
  text: z.string().max(8192),
  title: z.string().max(4096).optional(),
});
const transcriptSchema = z
  .array(
    z.object({
      prompt: z.string().max(64000),
      blocks: z.array(blockSchema).max(100),
    }),
  )
  .min(1)
  .max(20);
const toolInput = z.object({ title: z.string().max(4096), text: z.string().max(8192) }).strict();
type ToolInput = z.infer<typeof toolInput>;

function fixtureModel(context: vscode.ExtensionContext, ready: string) {
  const state = { requests: 0 };
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('vs-omp-reference', {
      provideLanguageModelChatInformation: () => [
        {
          id: 'recorded-only',
          name: 'Recorded Fixture Only',
          family: 'recorded-reference',
          version: '1',
          maxInputTokens: 32768,
          maxOutputTokens: 8192,
          capabilities: { toolCalling: true },
        },
      ],
      provideTokenCount: async () => 0,
      provideLanguageModelChatResponse: async (_model, _messages, options, progress) => {
        state.requests++;
        if (process.env.VS_OMP_REFERENCE_AGENT_PROBE === 'catalog') {
          assert.equal(
            state.requests,
            1,
            'The Agent catalog fixture permits one scripted request.',
          );
          const tools = JSON.stringify(options.tools ?? []);
          assert.ok(Buffer.byteLength(tools) <= 2 * 1024 * 1024);
          await writeFile(`${ready}.agent-tools.json`, tools, { mode: 0o600 });
          progress.report(new vscode.LanguageModelTextPart('PUBLIC_AGENT_CATALOG_ONLY'));
          await writeFile(`${ready}.agent-result.json`, JSON.stringify(state), { mode: 0o600 });
          return;
        }
        await writeFile(`${ready}.model-error.json`, JSON.stringify(state), {
          mode: 0o600,
        });
        throw new Error('The recorded reference must never request a model response.');
      },
    }),
  );
  return state;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const file = process.env.VS_OMP_REFERENCE_CHAT;
  const ready = process.env.VS_OMP_REFERENCE_READY;
  assert.ok(file && ready, 'The reference fixture requires explicit isolated inputs.');
  assert.ok((await stat(file)).size <= 2 * 1024 * 1024);
  const turns = transcriptSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const model = fixtureModel(context, ready);
  assert.equal((await vscode.lm.selectChatModels({ vendor: 'vs-omp-reference' })).length, 1);
  context.subscriptions.push(
    vscode.lm.registerTool<ToolInput>('vs_omp_recorded_result', {
      prepareInvocation: (options) => ({
        invocationMessage: 'Recorded: ' + toolInput.parse(options.input).title,
      }),
      invoke: (options) =>
        new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(toolInput.parse(options.input).text),
        ]),
    }),
  );
  let completed = 0;
  const participant = vscode.chat.createChatParticipant(
    'vs-omp.reference',
    async (request, _history, response, token) => {
      const turn = turns.find((candidate) => candidate.prompt === request.prompt.trim());
      assert.ok(turn, 'Only exact recorded prompts are admitted by the reference fixture.');
      const tools = JSON.stringify(
        vscode.lm.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
      );
      assert.ok(Buffer.byteLength(tools) <= 2 * 1024 * 1024);
      await writeFile(`${ready}.tools.json`, tools, { mode: 0o600 });
      response.markdown(
        '**Recorded fixture comparison. No workspace commands or model requests are executed.**\n\n',
      );
      for (const block of turn.blocks) {
        if (token.isCancellationRequested) return;
        if (block.kind === 'tool') {
          response.progress('Replaying a recorded tool result');
          await vscode.lm.invokeTool(
            'vs_omp_recorded_result',
            {
              input: { title: block.title ?? 'Tool result', text: block.text },
              toolInvocationToken: request.toolInvocationToken,
            },
            token,
          );
        } else response.markdown(block.text + '\n\n');
      }
      completed++;
      assert.equal(model.requests, 0);
      await writeFile(
        `${ready}.turn-${completed}.json`,
        JSON.stringify({ completed, fixture: true, modelRequests: model.requests }),
        { mode: 0o600 },
      );
      return { metadata: { recordedFixture: true } };
    },
  );
  participant.iconPath = new vscode.ThemeIcon('beaker');
  context.subscriptions.push(participant);
  await writeFile(
    ready,
    JSON.stringify({
      ready: true,
      prompts: turns.map((turn) => turn.prompt),
      environment: {
        vscode: vscode.version,
        theme: vscode.workspace.getConfiguration('workbench').get('colorTheme'),
        zoomLevel: vscode.workspace.getConfiguration('window').get('zoomLevel'),
        editorFontSize: vscode.workspace.getConfiguration('editor').get('fontSize'),
      },
    }),
    { mode: 0o600 },
  );
}
