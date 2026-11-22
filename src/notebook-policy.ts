import { z } from 'zod';
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type Node,
  type ParseError,
} from 'jsonc-parser';

const source = z
  .string()
  .max(524_288)
  .refine((value) => !value.includes('\0'));
export const notebookRequest = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.endsWith('.ipynb')),
    cell: z.number().int().min(1).max(1000),
    expectedSource: source,
    source,
  })
  .strict();
export type NotebookRequest = z.infer<typeof notebookRequest>;

function uniqueProperties(node: Node): void {
  if (node.type !== 'object') return;
  const names = new Set<string>();
  for (const property of node.children ?? []) {
    const name = property.children?.[0]?.value as string;
    if (names.has(name)) throw new Error('Notebook JSON contains duplicate properties.');
    names.add(name);
  }
}

function boundedTree(root: Node): void {
  const pending = [{ node: root, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 100_000 || depth > 64)
      throw new Error('Notebook JSON exceeds structural limits.');
    uniqueProperties(node);
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
  }
}

function notebookTree(text: string): Node {
  if (Buffer.byteLength(text) > 1_048_576 || text.includes('\0'))
    throw new Error('Notebook must be UTF-8 JSON up to 1 MiB.');
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length || tree.type !== 'object')
    throw new Error('Notebook must contain one strict JSON object.');
  boundedTree(tree);
  if (findNodeAtLocation(tree, ['nbformat'])?.value !== 4)
    throw new Error('Notebook cell edits support saved nbformat 4 files only.');
  return tree;
}

function notebookCell(tree: Node, index: number): Node {
  const cells = findNodeAtLocation(tree, ['cells']);
  if (cells?.type !== 'array' || cells.children!.length > 1000)
    throw new Error('Notebook must contain at most 1000 cells.');
  const cell = cells.children![index];
  if (cell?.type !== 'object') throw new Error('Notebook cell does not exist.');
  const kind = findNodeAtLocation(cell, ['cell_type'])?.value as unknown;
  if (kind !== 'code' && kind !== 'markdown' && kind !== 'raw')
    throw new Error('Notebook cell has an unsupported type.');
  return cell;
}

function cellSource(tree: Node, index: number): string {
  const cell = notebookCell(tree, index);
  const value = findNodeAtLocation(cell, ['source']);
  if (value?.type === 'string') return value.value as string;
  if (value?.type !== 'array' || !value.children!.every((child) => child.type === 'string'))
    throw new Error('Notebook cell source must be a string or an array of strings.');
  return value.children!.map((child) => child.value as string).join('');
}

export function replaceNotebookCell(text: string, value: NotebookRequest): string {
  const input = notebookRequest.parse(value);
  const tree = notebookTree(text);
  if (cellSource(tree, input.cell - 1) !== input.expectedSource)
    throw new Error('Notebook cell source is stale; read it again before editing.');
  if (input.source === input.expectedSource) return text;
  const previous = findNodeAtLocation(tree, ['cells', input.cell - 1, 'source'])!;
  const replacement =
    previous.type === 'string' ? input.source : (input.source.match(/[^\n]*\n|[^\n]+$/g) ?? []);
  const result = applyEdits(
    text,
    modify(text, ['cells', input.cell - 1, 'source'], replacement, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: text.includes('\r\n') ? '\r\n' : '\n',
      },
    }),
  );
  const changed = notebookTree(result);
  if (cellSource(changed, input.cell - 1) !== input.source)
    throw new Error('Notebook structural edit did not produce the requested cell source.');
  return result;
}
