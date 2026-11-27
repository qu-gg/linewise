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

export class CommandPermissions {
  private mode = defaultMode();

  constructor(private readonly assertIdle: () => void) {}

  get value(): PermissionMode {
    return this.mode;
  }

  reset(): void {
    this.assertIdle();
    this.mode = defaultMode();
  }

  set(mode: PermissionMode, confirmed = false): void {
    this.assertIdle();
    const next = permissionMode.parse(mode);
    if (next !== this.mode && (next === 'all' || next === 'yolo') && confirmed !== true)
      throw new Error('Elevated command permissions require explicit confirmation.');
    this.mode = next;
  }
}
