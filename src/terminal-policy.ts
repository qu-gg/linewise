import path from 'node:path';
import { parse } from 'shell-quote';
import { z } from 'zod';
import type { TerminalCommand } from './terminal.js';

export const permissionMode = z.enum(['ask', 'rules', 'all']);
export type PermissionMode = z.infer<typeof permissionMode>;
export type CommandDecision = 'allow' | 'ask' | 'deny';

const ruleSchema = z
  .object({
    command: z.array(z.string().min(1).max(1024)).min(1).max(32),
    action: z.enum(['allow', 'ask', 'deny']),
    match: z.enum(['prefix', 'exact']).default('prefix'),
  })
  .strict();

const rulesSchema = z.array(ruleSchema).max(128);
type CommandRule = z.infer<typeof ruleSchema>;

const shells = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh']);
const shellWrappers = new Set([
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'coproc',
  'time',
  'command',
  'builtin',
  'xargs',
  'timeout',
  'nice',
  'nohup',
  'setsid',
  'stdbuf',
  'chroot',
  'unshare',
  'busybox',
]);
const manualCommands = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'dd',
  'mkfs',
  'shred',
  'chmod',
  'chown',
  'chgrp',
  'sudo',
  'su',
  'doas',
  'kill',
  'pkill',
  'killall',
  'shutdown',
  'reboot',
  'poweroff',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'env',
  'eval',
  'exec',
  'source',
  '.',
  ...shells,
]);
const readers = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'pwd']);
const findWrites = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);
const gitWrites = new Set([
  'reset',
  'clean',
  'restore',
  'checkout',
  'switch',
  'stash',
  'push',
  'commit',
  'rebase',
  'merge',
]);

function executable(value: string): string {
  return /^\/(?:usr\/)?bin\/[^/]+$/.test(value) ? path.basename(value) : value;
}

function completeQuotes(source: string): boolean {
  let quote = '';
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === "'" || character === '"') quote = character;
  }
  return !quote && !escaped;
}

function parseSegments(source: string) {
  let certain = true;
  const segments: string[][] = [[]];
  try {
    for (const token of parse(source, {})) {
      if (typeof token === 'string') segments.at(-1)!.push(token);
      else {
        if (!('op' in token) || !['&&', '||', '|', ';'].includes(token.op)) certain = false;
        if ('op' in token && token.op === 'glob') segments.at(-1)!.push(token.pattern);
        else segments.push([]);
      }
    }
  } catch {
    certain = false;
  }
  return { segments, certain };
}

function splitCommand(command: Readonly<TerminalCommand>) {
  const name = executable(command.command);
  if (!shells.has(name))
    return { segments: [[name, ...command.args]], certain: !shellWrappers.has(name) };
  if (
    !['sh', 'bash', 'dash'].includes(name) ||
    !['["-c"]', '["-lc"]', '["-l","-c"]'].includes(JSON.stringify(command.args.slice(0, -1)))
  ) {
    return { segments: [[name, ...command.args]], certain: false };
  }
  const source = command.args.at(-1)!;
  const parsed = parseSegments(source);
  const control = Array.from(source).some((character) => character.charCodeAt(0) < 32);
  const literal =
    completeQuotes(source) &&
    !control &&
    !/[$`{}()\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(source);
  return {
    segments: parsed.segments,
    certain:
      parsed.certain &&
      literal &&
      parsed.segments.every(
        (segment) => segment.length > 0 && !shellWrappers.has(executable(segment[0]!)),
      ),
  };
}

function matches(rule: CommandRule, words: readonly string[]): boolean {
  if (rule.match === 'exact' && rule.command.length !== words.length) return false;
  return rule.command.every((word, index) => word === words[index]);
}

function effectiveWords(words: readonly string[]): string[] {
  const first = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const result = words.slice(first < 0 ? words.length : first);
  if (result[0]) result[0] = executable(result[0]);
  return result;
}

function gitDecision(args: readonly string[]): CommandDecision {
  if (gitWrites.has(args[0] ?? '')) return 'ask';
  return args[0] === 'status' &&
    args
      .slice(1)
      .every((arg) =>
        /^(-s|-b|-sb|--short|--branch|--porcelain(?:=v[12])?|--untracked-files=(?:no|normal|all))$/.test(
          arg,
        ),
      )
    ? 'allow'
    : 'ask';
}

function defaultDecision(words: readonly string[]): CommandDecision | undefined {
  const [name = '', ...args] = words;
  if (manualCommands.has(name)) return 'ask';
  if (name === 'find') return args.some((arg) => findWrites.has(arg)) ? 'ask' : 'allow';
  if (name === 'rg')
    return args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg)) ? 'ask' : 'allow';
  if (name === 'git') {
    return gitDecision(args);
  }
  return readers.has(name) ? 'allow' : undefined;
}

function segmentDecision(
  words: readonly string[],
  rules: CommandRule[],
  mode: PermissionMode,
  defaults: boolean,
): CommandDecision {
  if (rules.some((rule) => rule.action === 'allow' && matches(rule, words))) return 'allow';
  const decision = defaults ? defaultDecision(words) : undefined;
  return decision ?? (mode === 'all' ? 'allow' : 'ask');
}

function restriction(segments: string[][], rules: CommandRule[]): 'deny' | 'ask' | undefined {
  for (const action of ['deny', 'ask'] as const) {
    if (
      rules.some((rule) => rule.action === action && segments.some((words) => matches(rule, words)))
    )
      return action;
  }
}

function automaticContext(command: Readonly<TerminalCommand>, segments: string[][]): boolean {
  return (
    !segments.some((words) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) &&
    Object.keys(command.env).every((name) =>
      /^PI_(SESSION_ID|SESSION_FILE|TOOL_CALL_ID)$/.test(name),
    )
  );
}

export function commandDecision(
  command: Readonly<TerminalCommand>,
  mode: PermissionMode,
  configuredRules: unknown = [],
  defaults = true,
): CommandDecision {
  const rules = rulesSchema.safeParse(configuredRules);
  if (!rules.success || typeof defaults !== 'boolean')
    throw new Error('Invalid OMP command rules; execution is disabled. Check user settings.');
  const parsed = splitCommand(command);
  const segments = parsed.segments.map(effectiveWords);
  const restricted = restriction(segments, rules.data);
  if (restricted) return restricted;
  if (mode === 'ask' || !parsed.certain) return 'ask';
  if (!automaticContext(command, parsed.segments)) return 'ask';
  return segments.every((words) => segmentDecision(words, rules.data, mode, defaults) === 'allow')
    ? 'allow'
    : 'ask';
}
