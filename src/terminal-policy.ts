import path from 'node:path';
import { parse } from 'shell-quote';
import { z } from 'zod';
import type { TerminalCommand } from './terminal.js';
import { pathReason } from './file-policy.js';

export const permissionMode = z.enum(['ask', 'rules', 'all', 'yolo']);
export type PermissionMode = z.infer<typeof permissionMode>;
export type CommandDecision = 'allow' | 'ask' | 'deny';

export const shellInput = z
  .object({
    command: z.string().min(1).max(65536),
    i: z.string().nullish(),
    timeout: z.number().min(0).max(120).nullish(),
    cwd: z
      .string()
      .max(4096)
      .refine((value) => !value || !pathReason(value, false))
      .nullish(),
    pty: z.boolean().nullish(),
    visibility: z.enum(['hidden', 'background', 'foreground']).optional(),
  })
  .strict();

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
const yoloDenied = new Set([
  'mkfs',
  'mkswap',
  'wipefs',
  'fdisk',
  'sfdisk',
  'cfdisk',
  'parted',
  'shred',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
  'telinit',
]);
const yoloWrappers = new Set([...shellWrappers, 'sudo', 'su', 'doas', 'env', 'exec']);

function protectedRemoval(value: string): boolean {
  const normalized = path.posix.normalize(value).replace(/\/+$/, '') || '/';
  return (
    [
      '.',
      '..',
      '/',
      '~',
      '~/*',
      '$HOME',
      '$HOME/*',
      '${HOME}',
      '${HOME}/*',
      '/home',
      '/root',
      '/etc',
      '/usr',
      '/var',
      '/boot',
      '/dev',
      '/proc',
      '/sys',
      '/tmp',
    ].includes(normalized) ||
    /^\/(?:home|Users)\/[^/]+\/?\*?$/.test(normalized) ||
    /^\/(?:\*|(?:etc|usr|var|boot|dev|proc|sys|root|home)\/\*)$/.test(normalized)
  );
}

function yoloExecutableRisk(name: string, args: readonly string[]): boolean {
  if (yoloDenied.has(name) || name.startsWith('mkfs.')) return true;
  if (name === 'rm')
    return args.some((arg) => /^-[^-]*[rR]|^--recursive$/.test(arg)) && args.some(protectedRemoval);
  if (name === 'dd')
    return args.some((arg) =>
      /^of=\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\/)/.test(arg),
    );
  return false;
}

function yoloRisk(words: readonly string[], depth = 0): boolean {
  const [first = '', ...args] = words;
  const name = path.basename(first);
  if (yoloExecutableRisk(name, args)) return true;
  if (depth >= 8) return yoloWrappers.has(name) || shells.has(name);
  if (shells.has(name) || name === 'eval') return yoloScriptRisk(args.at(-1) ?? '', depth + 1);
  return (
    yoloWrappers.has(name) &&
    args.some((_, index) => yoloRisk(effectiveWords(args.slice(index)), depth + 1))
  );
}

function yoloScriptRisk(source: string, depth = 0): boolean {
  return (
    /([A-Za-z_][A-Za-z0-9_]*|:)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}/.test(source) ||
    />\s*\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\/)/.test(source) ||
    parseSegments(source).segments.some((words) => yoloRisk(effectiveWords(words), depth))
  );
}

function yoloSourceRisk(command: Readonly<TerminalCommand>): boolean {
  return shells.has(path.basename(command.command)) && yoloScriptRisk(command.args.at(-1) ?? '');
}

function executable(value: string): string {
  return /^\/(?:usr\/)?bin\/[^/]+$/.test(value) ? path.basename(value) : value;
}

function unquotedNewline(character: string, quote: string, escaped: boolean): string {
  return character === '\n' && !quote && !escaped ? ';' : character;
}

function parsedSource(source: string): { complete: boolean; source: string } {
  let quote = '';
  let escaped = false;
  const result: string[] = [];
  for (const character of source) {
    result.push(unquotedNewline(character, quote, escaped));
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
  return { complete: !quote && !escaped, source: result.join('') };
}

function parseSegments(source: string) {
  let certain = true;
  const segments: string[][] = [[]];
  try {
    for (const token of parse(parsedSource(source).source, (name) => `$${name}`)) {
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
    parsedSource(source).complete &&
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

function yoloBlocked(
  command: Readonly<TerminalCommand>,
  mode: PermissionMode,
  segments: string[][],
): boolean {
  return mode === 'yolo' && (segments.some((words) => yoloRisk(words)) || yoloSourceRisk(command));
}

function needsApproval(
  command: Readonly<TerminalCommand>,
  mode: PermissionMode,
  parsed: ReturnType<typeof splitCommand>,
): boolean {
  return mode === 'ask' || !parsed.certain || !automaticContext(command, parsed.segments);
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
  if (yoloBlocked(command, mode, segments)) return 'deny';
  const restricted = restriction(segments, rules.data);
  if (restricted) return restricted;
  if (mode === 'yolo') return 'allow';
  if (needsApproval(command, mode, parsed)) return 'ask';
  return segments.every((words) => segmentDecision(words, rules.data, mode, defaults) === 'allow')
    ? 'allow'
    : 'ask';
}
