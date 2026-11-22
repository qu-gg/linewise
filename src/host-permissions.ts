import * as vscode from 'vscode';
import { permissionMode } from './terminal-policy.js';
import type { PermissionMode } from './terminal-policy.js';

export function permissionSetting<Value>(key: string, fallback: Value): Value {
  const inspected = vscode.workspace.getConfiguration('omp').inspect<Value>(`permissions.${key}`);
  return inspected?.globalValue === undefined ? fallback : inspected.globalValue;
}

function defaultMode(): PermissionMode {
  return permissionMode.exclude(['all', 'yolo']).parse(permissionSetting('defaultMode', 'rules'));
}

async function confirmPermissions(mode: PermissionMode, current: PermissionMode): Promise<boolean> {
  if (!['all', 'yolo'].includes(mode) || current === mode) return true;
  const yolo = mode === 'yolo';
  const choice = yolo ? 'Enable YOLO' : 'Enable Allow All';
  const enabled = await vscode.window.showWarningMessage(
    yolo
      ? 'Enable YOLO command execution for this connection?'
      : 'Allow commands without confirmation for this connection?',
    {
      modal: true,
      detail: yolo
        ? 'Automatically approves commands, including shell expansions, redirects and destructive project operations. Commands run with your host permissions, without an OS sandbox, and can delete files or send credentials/data. A small known-dangerous-command denylist and explicit user deny/ask rules remain, but cannot reliably detect actions hidden in scripts, variables or interpreters. File review, outside-file approvals, web/browser consent, tool restrictions and Stop stay unchanged. This choice resets on reconnect or session switch; it is not Autopilot.'
        : 'Commands run with your host permissions, without an OS sandbox, and can delete files or send data. Explicit deny rules still block; ask rules and uncertain syntax still prompt. File approvals and tool restrictions stay unchanged. This choice resets on reconnect or session switch.',
    },
    choice,
  );
  return enabled === choice;
}

export class CommandPermissions {
  private mode = defaultMode();
  private epoch = 0;

  constructor(private readonly assertIdle: () => void) {}

  get value(): PermissionMode {
    return this.mode;
  }

  reset(): void {
    this.assertIdle();
    this.epoch++;
    this.mode = defaultMode();
  }

  async pick(): Promise<void> {
    this.assertIdle();
    const epoch = ++this.epoch;
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(shield) Ask Every Time', value: 'ask' },
        { label: '$(checklist) Command Rules', value: 'rules' },
        { label: '$(unlock) Allow All Except Restrictions', value: 'all' },
        { label: '$(warning) YOLO Commands', value: 'yolo' },
        { label: '$(settings-gear) Edit User Command Rules', value: 'settings' },
      ],
      {
        title: 'OMP Command Permissions',
        placeHolder: `Current mode: ${this.mode}`,
        ignoreFocusOut: true,
      },
    );
    if (!picked || epoch !== this.epoch) return;
    if (picked.value === 'settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@id:omp.permissions.commandRules',
      );
      return;
    }
    const mode = permissionMode.parse(picked.value);
    if (!(await confirmPermissions(mode, this.mode)) || epoch !== this.epoch) return;
    this.assertIdle();
    this.mode = mode;
  }
}
