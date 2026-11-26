import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectOptions, OmpClient } from './acp.js';
import { HostTools, toolConfiguration } from './host-tools.js';
import {
  instructionArguments,
  workspaceInstructions,
  withInstructionSnapshot,
} from './workspace-instructions.js';
import { checkedReadPath } from './file-policy.js';
import { reconcileHistory, type SavedSession, type StateStore } from './state.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ContextAttachments } from './context.js';

export function createConnection(
  files: ConstructorParameters<typeof HostTools>[0],
  journal: ConstructorParameters<typeof HostTools>[1],
  artifacts: string,
  approval: ConstructorParameters<typeof HostTools>[3],
  handlers: {
    update: (notification: SessionNotification) => void;
    closed: (client: OmpClient, tools: HostTools) => void;
    log: (message: string) => void;
    questions?: ConstructorParameters<typeof HostTools>[4];
  },
) {
  const tools = new HostTools(
    files,
    journal,
    path.join(artifacts, 'mutations'),
    approval,
    handlers.questions,
  );
  const client = new OmpClient(
    {
      update: async (notification) => handlers.update(notification),
      closed: () => handlers.closed(client, tools),
      read: (request) => tools.read(request),
      write: (request) => tools.write(request),
      terminals: tools,
      permission: (request) => tools.permission(request),
    },
    handlers.log,
  );
  return { tools, client };
}

export async function bindConnectedSession(
  store: StateStore,
  client: OmpClient,
  root: { uri: string; name: string },
  saved?: SavedSession,
  attachments?: ContextAttachments,
) {
  if (!client.sessionId) throw new Error('OMP did not return a session identifier.');
  const previousOwner = store.data.activeSessionId;
  if (!saved)
    store.data.sessions.push({ id: client.sessionId, root: root.uri, label: root.name, turns: [] });
  store.data.activeSessionId = saved?.id ?? client.sessionId;
  const active = store.data.sessions.find((session) => session.id === store.data.activeSessionId)!;
  if (client.historyAvailable) active.sessionFile = (await client.history()).fileName;
  attachments?.bindSession(active.id, previousOwner, Boolean(saved));
  if (!saved?.historyTransition) return false;
  reconcileHistory(saved, await client.history());
  return true;
}

export async function artifactsDirectory(directory: string): Promise<string> {
  const native = path.join(directory, 'omp-sessions');
  await mkdir(native, { recursive: true, mode: 0o700 });
  return realpath(native);
}

async function legacyFile(directory: string, saved: SavedSession) {
  const candidates = (await readdir(directory)).filter(
    (file) => file.endsWith(`_${saved.id}.jsonl`) && /^[\w.-]+\.jsonl$/.test(file),
  );
  if (candidates.length === 1) return candidates[0];
  if (saved.turns.length)
    throw new Error(
      'The native session file is unavailable. The saved transcript and pending changes have not been removed.',
    );
  return undefined;
}

export async function resumeArtifact(directory: string, saved?: SavedSession) {
  if (!saved) return undefined;
  const file = saved.sessionFile ?? (await legacyFile(directory, saved));
  if (!file || saved.turns.length) return file;
  try {
    await stat(path.join(directory, file));
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function startupConfig(directory: string, backend: unknown, fixture?: string) {
  if (!['off', 'local', 'mnemopi'].includes(String(backend)))
    throw new Error('This build supports local or Mnemopi memory, not remote memory services.');
  const offline = fixture || backend === 'off';
  const config = path.join(directory, 'session-config.json');
  await writeFile(
    config,
    JSON.stringify({
      memory: { backend: offline ? 'mnemopi' : backend },
      ...(offline
        ? {
            mnemopi: {
              noEmbeddings: true,
              llmMode: 'none',
              scoping: 'per-project',
              ...(fixture
                ? {
                    dbPath: path.join(directory, 'fixture-memory.sqlite'),
                    autoRecall: true,
                    autoRetain: true,
                  }
                : {}),
            },
          }
        : {}),
      ...toolConfiguration,
    }),
    { mode: 0o600 },
  );
  return config;
}

export function startupArguments(
  config: string,
  guard: string,
  artifacts: string,
  fixture?: string,
  instructions?: string,
) {
  return [
    '--config',
    config,
    ...instructionArguments(instructions),
    '--no-extensions',
    '--extension',
    guard,
    ...(fixture ? ['--extension', fixture] : []),
    '--tools',
    'read,write,todo,retain,recall,memory_edit,edit,bash',
    '--no-lsp',
    '--no-title',
    '--session-dir',
    artifacts,
    '--approval-mode',
    'write',
  ];
}

export async function startSessionClient(
  client: OmpClient,
  options: Omit<Parameters<OmpClient['start']>[0], 'args'> & {
    config: string;
    storage: string;
    guard: string;
    fixture?: string;
  },
  read: (target: string) => Promise<string | null>,
): Promise<void> {
  const { storage, config, guard, fixture, ...start } = options;
  const instructions = await workspaceInstructions(start.cwd, async (target) =>
    read(await checkedReadPath(target, start.cwd, storage)),
  );
  await withInstructionSnapshot(storage, instructions, (snapshot) =>
    client.start({
      ...start,
      args: startupArguments(config, guard, start.artifacts, fixture, snapshot),
    }),
  );
  if (!client.sessionId) throw new Error('OMP did not return a session identifier.');
}

export async function selectModel(
  client: OmpClient,
  store: StateStore,
  configured: string,
  resume = false,
): Promise<void> {
  const sticky = store.data.lastModel;
  store.data.lastModel = await applyModel(client, sticky ?? configured, resume, Boolean(sticky));
}

async function applyModel(
  client: OmpClient,
  preferred: string,
  resume: boolean,
  fallback: boolean,
): Promise<string> {
  const model = client.configOptions.find((option) => option.id === 'model');
  if (!model) throw new Error('OMP did not advertise a model selector.');
  const current = String(model.currentValue);
  if (resume) return current;
  const choices = selectOptions(model);
  if (!choices.length)
    throw new Error(
      'No OMP models are available. Run omp in a terminal and use /login for a provider.',
    );
  const selection = preferred.trim();
  if (selection) {
    const chosen = choices.find((option) => option.value === selection);
    if (chosen) {
      if (chosen.value !== current) await client.setConfig('model', chosen.value);
      return chosen.value;
    }
    if (!fallback)
      throw new Error(
        `The configured omp.model "${selection}" is not an advertised OMP model. Update the setting or run /login for that provider.`,
      );
  }
  if (choices.some((option) => option.value === current)) return current;
  const next = choices[0]!.value;
  await client.setConfig('model', next);
  return next;
}

export async function configureSession(
  client: OmpClient | undefined,
  store: StateStore,
  id: string,
  value: string,
) {
  const option = client?.configOptions.find((candidate) => candidate.id === id);
  if (!option || !selectOptions(option).some((candidate) => candidate.value === value))
    throw new Error('Unsupported session option.');
  await client!.setConfig(id, value);
  const session = store.data.sessions.find((saved) => saved.id === store.data.activeSessionId);
  if (id === 'model') {
    store.data.lastModel = value;
    if (session?.usage) session.usage.stale = true;
  }
  await store.save();
}
