import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type NodeRuntimeMode = 'auto' | 'host' | 'system';

const HOST_MAJOR = Number(process.versions.node.split('.')[0]);
const HOST_VERSION = process.versions.node;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function declaredMajor(cwd: string): number | undefined {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 8; depth++) {
    for (const name of ['.nvmrc', '.node-version']) {
      const major = readMajor(path.join(current, name));
      if (major !== undefined) return major;
    }
    const packageMajor = packageEngineMajor(path.join(current, 'package.json'));
    if (packageMajor !== undefined) return packageMajor;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function readMajor(file: string): number | undefined {
  try {
    return parseMajor(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseMajor(value: string): number | undefined {
  const match = value.trim().match(/^(?:v|>=|\^|~)?\s*(\d+)/);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major > 0 ? major : undefined;
}

function packageEngineMajor(file: string): number | undefined {
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as {
      engines?: { node?: unknown };
    };
    return typeof body.engines?.node === 'string' ? parseMajor(body.engines.node) : undefined;
  } catch {
    return undefined;
  }
}

function usesHostNode(mode: NodeRuntimeMode, cwd: string): boolean {
  if (mode === 'host') return true;
  if (mode === 'system') return false;
  const declared = declaredMajor(cwd);
  return declared !== undefined && HOST_MAJOR >= declared;
}

let shimDirectory: string | undefined;

function ensureShim(): string {
  if (shimDirectory) return shimDirectory;
  const root =
    process.env.VS_OMP_ARTIFACTS_ROOT ??
    path.join(os.tmpdir(), `linewise-node-${process.getuid?.() ?? 'user'}`);
  const directory = path.join(root, 'runtime');
  const executable = path.join(directory, 'node');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(executable))
    writeFileSync(
      executable,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} "$@"\n`,
      { mode: 0o700 },
    );
  chmodSync(executable, 0o700);
  shimDirectory = directory;
  return directory;
}

/** Environment additions for agent-owned shell commands, never the user's terminal. */
export function agentRuntimeEnvironment(
  mode: NodeRuntimeMode,
  cwd: string,
): Array<{ name: string; value: string }> {
  const environment = [
    { name: 'LINEWISE_NODE', value: process.execPath },
    { name: 'LINEWISE_NODE_VERSION', value: HOST_VERSION },
  ];
  if (!usesHostNode(mode, cwd)) return environment;
  const shim = ensureShim();
  return [
    ...environment,
    { name: 'PATH', value: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
  ];
}

export { HOST_MAJOR };

export function resetRuntimeCache(): void {
  shimDirectory = undefined;
}
