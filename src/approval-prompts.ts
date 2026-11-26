import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { ApprovalPrompt } from './approvals.js';
import type { Approval } from './review.js';
import type { TerminalCommand } from './terminal.js';
import type { BrowserRequest } from './browser-policy.js';

export function visible(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
    if (character === '\n' || character === '\t') return character;
    const code = character.codePointAt(0)!;
    return code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : `\\u{${code.toString(16)}}`;
  });
}

function display(value: unknown): string {
  return visible(JSON.stringify(value, null, 2));
}

function commandPreview(command: Readonly<TerminalCommand>): string {
  const shell = ['bash', 'sh', 'dash'].includes(path.basename(command.command));
  const [first, second, third] = command.args;
  if (shell && command.args.length === 2 && ['-c', '-lc'].includes(first!)) return visible(second!);
  if (shell && command.args.length === 3 && first === '-l' && second === '-c')
    return visible(third!);
  return [command.command, ...command.args].map((argument) => display(argument)).join(' ');
}

export function commandApproval(command: Readonly<TerminalCommand>): ApprovalPrompt {
  return {
    kind: 'command',
    title: `Run ${visible(path.basename(command.command))} command?`,
    summary: commandPreview(command),
    cwd: visible(command.cwd),
    notice: 'Not sandboxed. Allow applies once.',
    configurable: true,
    details: [
      `Executable: ${display(command.command)}`,
      `Arguments: ${display(command.args)}`,
      `Working directory: ${display(command.cwd)}`,
      `Environment overrides: ${display(command.env)}`,
      'Commands can change files outside the workspace, access host credentials or send data. They are not sandboxed. File and external side effects are not covered by Keep/Discard or conversation rewind. Review resulting files in Source Control.',
      'Only ordinary path/home/user/locale/terminal/temp variables are inherited. Explicit shell arguments can run arbitrary scripts. Approval applies once to this command only.',
    ].join('\n\n'),
  };
}

export function browserApproval(request: BrowserRequest, executablePath?: string): ApprovalPrompt {
  return {
    kind: 'command',
    title: 'Allow Owned Browser Action?',
    summary: `Browser: ${request.action}`,
    details: JSON.stringify({
      executable: executablePath || 'Playwright-managed Chromium',
      request,
    }),
    notice:
      'Isolated OMP-owned browser only, not existing tabs or profiles. Pages, site state and background network activity persist between prompts in this session until Close Owned Browser, Stop, disconnect or ownership changes. Page content is untrusted. Host network/web side effects are not sandboxed or restored by review.',
    configurable: false,
  };
}

export function fileApproval(operation: Parameters<Approval>[0]): ApprovalPrompt {
  const details =
    operation.kind === 'read'
      ? 'The requested file content will be sent to the configured model provider.'
      : createTwoFilesPatch(
          operation.path,
          operation.destination ?? operation.path,
          operation.before ?? '',
          operation.after ?? '',
        );
  return {
    kind: 'file',
    title: `Allow outside-workspace ${operation.kind}?`,
    summary: visible(operation.path),
    destination: operation.destination === undefined ? undefined : visible(operation.destination),
    details: visible(details),
    notice:
      operation.kind === 'read'
        ? 'File content will be sent to the configured model. Allow applies once.'
        : 'Outside the workspace. Allow applies once.',
  };
}
