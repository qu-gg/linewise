import assert from 'node:assert/strict';
import test from 'node:test';
import type { NativeEditApi } from '../native-edit.js';
import { installNativeBrowser } from '../native-browser.js';
import { installNativeEditor } from '../native-editor.js';
import { installNativeShell } from '../native-shell.js';
import { providerObjectSchema } from '../tool-schema.js';

function register(install: (api: Pick<NativeEditApi, 'registerTool'>) => void) {
  let tool!: Parameters<NativeEditApi['registerTool']>[0];
  install({ registerTool: (definition) => (tool = definition) });
  return tool;
}

test('provider schemas flatten root unions and merge discriminator values', () => {
  const schema = providerObjectSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    anyOf: [
      {
        type: 'object',
        properties: {
          action: { type: 'string', const: 'read' },
          jobId: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['stop'] },
          jobId: { type: 'string' },
        },
        required: ['action', 'jobId'],
        additionalProperties: false,
      },
    ],
  });
  assert.equal(schema.type, 'object');
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['action']);
  assert.deepEqual((schema.properties as Record<string, { enum?: string[] }>).action!.enum, [
    'read',
    'stop',
  ]);
});

test('provider schemas preserve object roots and reject impossible roots', () => {
  const object = { type: 'object', properties: {} };
  assert.equal(providerObjectSchema(object), object);
  assert.throws(() => providerObjectSchema({ type: 'array' }), /root must be an object/);
  assert.throws(() => providerObjectSchema({ anyOf: [] }), /at least one branch/);
  assert.throws(
    () => providerObjectSchema({ anyOf: [{ type: 'string' }] }),
    /branches must be objects/,
  );
  assert.throws(
    () => providerObjectSchema({ anyOf: [{ type: 'object', properties: { value: 1 } }] }),
    /must be an object schema/,
  );
  const conflicting = providerObjectSchema({
    anyOf: [
      { type: 'object', properties: { value: { type: 'string' } } },
      { type: 'object', properties: { value: { type: 'number' } } },
    ],
  });
  assert.deepEqual((conflicting.properties as Record<string, unknown>).value, {
    anyOf: [{ type: 'string' }, { type: 'number' }],
  });
});

test('native bash, browser and editor schemas use object roots', () => {
  const shell = register(installNativeShell);
  const browser = register(installNativeBrowser);
  const editor = register(installNativeEditor);
  for (const tool of [shell, browser, editor]) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.anyOf, undefined);
    assert.equal(tool.parameters.oneOf, undefined);
    assert.equal(tool.strict, false);
  }
  const actions = (tool: typeof shell) =>
    (tool.parameters.properties as Record<string, { enum?: string[] }>).action!.enum!;
  assert.ok(actions(shell).includes('stop'));
  assert.ok(actions(browser).includes('viewport'));
  assert.ok(actions(editor).includes('semanticSearch'));
  assert.equal(shell.parameters.required, undefined);
  assert.deepEqual(browser.parameters.required, ['action']);
  assert.deepEqual(editor.parameters.required, ['action']);
});
