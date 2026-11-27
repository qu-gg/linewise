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
import type { HostView } from './host-view.js';
import { dropEmptySession } from './sessions.js';
import { routeBaseModel } from './model-routes.js';
import type { LaunchRoute } from './model-route.js';
import type { PermissionMode } from './terminal-policy.js';

export function createConnection(
  files: ConstructorParameters<typeof HostTools>[0],
  journal: ConstructorParameters<typeof HostTools>[1],
  artifacts: string,
  approval: ConstructorParameters<typeof HostTools>[3],
  permissions: PermissionMode,
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
  tools.setPermissions(permissions, true);
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

export interface BoundSession {
  recovered: boolean;
  createdId?: string;
  previousOwner?: string;
}

function restoreStagedAttachments(
  attachments: ContextAttachments | undefined,
  sessionId: string,
  previousOwner: string | undefined,
): void {
  // Only a first connect moves the staged "new" draft onto the created identity.
  const staged = previousOwner ? [] : (attachments?.list(sessionId) ?? []);
  attachments?.clear(sessionId);
  if (staged.length) attachments?.add('new', staged);
}

async function applyConnectionBinding(
  store: StateStore,
  client: OmpClient,
  existing: SavedSession,
  previousOwner: string | undefined,
  resumed: boolean,
  attachments?: ContextAttachments,
): Promise<boolean> {
  const active = store.data.sessions.find((session) => session.id === store.data.activeSessionId);
  if (!active) throw new Error('The active session record is unavailable.');
  if (client.historyAvailable) active.sessionFile = (await client.history()).fileName;
  attachments?.bindSession(active.id, previousOwner, resumed);
  if (!existing.historyTransition) return false;
  reconcileHistory(existing, await client.history());
  return true;
}

interface SessionIdentity {
  existing: SavedSession;
  created: boolean;
}

function sessionIdentity(
  store: StateStore,
  saved: SavedSession | undefined,
  id: string,
  root: { uri: string; name: string },
): SessionIdentity {
  const existing = saved ?? store.data.sessions.find((session) => session.id === id);
  if (existing) return { existing, created: false };
  const created: SavedSession = { id, root: root.uri, label: root.name, turns: [] };
  store.data.sessions.push(created);
  return { existing: created, created: true };
}

function assertNewSessionIdentity(existing: SavedSession, saved: SavedSession | undefined): void {
  if (saved) return;
  if (existing.turns.length > 0 || existing.historyTransition || existing.title !== undefined)
    throw new Error(
      'OMP returned an existing session identity for a new chat. Reconnect or open that session explicitly.',
    );
}

export async function bindConnectedSession(
  store: StateStore,
  client: OmpClient,
  root: { uri: string; name: string },
  saved?: SavedSession,
  attachments?: ContextAttachments,
): Promise<BoundSession> {
  const id = client.sessionId;
  if (!id) throw new Error('OMP did not return a session identifier.');
  const previousOwner = store.data.activeSessionId;
  const identity = sessionIdentity(store, saved, id, root);
  assertNewSessionIdentity(identity.existing, saved);
  if (identity.existing.archivedAt !== undefined)
    throw new Error('OMP returned an archived session identity. Restore that session first.');
  const createdId = identity.created ? identity.existing.id : undefined;
  store.data.activeSessionId = identity.existing.id;
  try {
    const recovered = await applyConnectionBinding(
      store,
      client,
      identity.existing,
      previousOwner,
      !identity.created,
      attachments,
    );
    return { recovered, createdId, previousOwner };
  } catch (error) {
    if (createdId) {
      store.data.sessions = store.data.sessions.filter((session) => session.id !== createdId);
      restoreStagedAttachments(attachments, createdId, previousOwner);
    }
    store.data.activeSessionId = previousOwner;
    throw error;
  }
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
  model?: string,
) {
  return [
    ...(model ? ['--model', model] : []),
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
    model?: string;
  },
  read: (target: string) => Promise<string | null>,
): Promise<void> {
  const { storage, config, guard, fixture, model, ...start } = options;
  const instructions = await workspaceInstructions(start.cwd, async (target) =>
    read(await checkedReadPath(target, start.cwd, storage)),
  );
  await withInstructionSnapshot(storage, instructions, (snapshot) =>
    client.start({
      ...start,
      args: startupArguments(config, guard, start.artifacts, fixture, snapshot, model),
    }),
  );
  if (!client.sessionId) throw new Error('OMP did not return a session identifier.');
}

type Run = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface ConnectionHost {
  view: HostView;
  store: StateStore;
  executable: string;
  run: Run;
  guard: string;
  fixture?: string;
  permissions: PermissionMode;
  configuredModel: string;
  saved?: SavedSession;
  replace?: SavedSession;
  launch?: LaunchRoute;
  update(notification: SessionNotification): void;
  closed(client: OmpClient, tools: HostTools): void;
  setClient(client: OmpClient, tools: HostTools): void;
  setError(message: string): void;
  log(message: string): void;
  clearPending(): void;
  refreshRoutes(): void;
}

export async function applyStartupModel(
  client: OmpClient,
  store: StateStore,
  saved: SavedSession | undefined,
  configured: string,
  launch?: LaunchRoute,
): Promise<void> {
  if (!launch) {
    await selectModel(client, store, configured, Boolean(saved));
    return;
  }
  const current = client.configOptions.find((option) => option.id === 'model')?.currentValue;
  const model = routeBaseModel(launch.selector);
  if (current !== model) throw new Error('OMP did not start on the selected OpenRouter model.');
  store.data.lastModel = model;
}

async function persistConnectedSession(
  view: HostView,
  store: StateStore,
  host: ConnectionHost,
  binding: BoundSession,
  previous: SavedSession | undefined,
  launch: LaunchRoute | undefined,
): Promise<void> {
  if (binding.recovered)
    host.setError(
      'Recovered an interrupted conversation edit. Its full original is in Switch Session. Files were not changed.',
    );
  if (launch) host.clearPending();
  const dropped = previous
    ? dropEmptySession(
        store,
        previous,
        view.active()?.id,
        (id) => view.journal.list(id).length,
        (id) => view.attachments.count(id),
        (id) => view.attachments.clear(id),
      )
    : undefined;
  try {
    await view.journal.refresh();
    await store.save();
  } catch (error) {
    if (binding.createdId) {
      store.data.sessions = store.data.sessions.filter(
        (session) => session.id !== binding.createdId,
      );
      restoreStagedAttachments(view.attachments, binding.createdId, binding.previousOwner);
    }
    if (dropped) store.data.sessions.push(dropped);
    store.data.activeSessionId = binding.previousOwner;
    throw error;
  }
}

export async function establishConnection(host: ConnectionHost): Promise<void> {
  const { view, store, executable, saved, permissions, replace, launch } = host;
  const root = view.root(saved);
  const directory = store.directory;
  const artifacts = await artifactsDirectory(directory);
  const sessionFile = await resumeArtifact(artifacts, saved);
  const backend = await host.run(executable, ['config', 'get', 'memory.backend', '--json'], {
    cwd: root.uri.fsPath,
    timeout: 15_000,
    maxBuffer: 65536,
  });
  const config = await startupConfig(directory, JSON.parse(backend.stdout).value, host.fixture);
  view.assertRoot(root);
  const { tools, client } = createConnection(
    view.files,
    view.journal,
    artifacts,
    view.chat.requestApproval,
    permissions,
    {
      update: host.update,
      closed: host.closed,
      log: host.log,
      questions: view.chat.requestQuestions,
    },
  );
  host.setClient(client, tools);
  await startSessionClient(
    client,
    {
      executable,
      cwd: root.uri.fsPath,
      artifacts,
      sessionFile,
      config,
      storage: directory,
      guard: host.guard,
      fixture: host.fixture,
      model: launch?.selector,
    },
    (target) => view.journal.inspect(target),
  );
  await applyStartupModel(client, store, saved, host.configuredModel, launch);
  view.assertRoot(root);
  const binding = await bindConnectedSession(
    store,
    client,
    { uri: root.uri.toString(), name: root.name },
    saved,
    view.attachments,
  );
  await persistConnectedSession(view, store, host, binding, replace ?? launch?.replace, launch);
  view.assertRoot(root);
  host.refreshRoutes();
}

export async function selectModel(
  client: OmpClient,
  store: StateStore,
  configured: string,
  resume = false,
): Promise<void> {
  const lastModel = store.data.lastModel;
  store.data.lastModel = await applyModel(
    client,
    lastModel ?? configured,
    resume,
    Boolean(lastModel),
  );
}

async function applyModel(
  client: OmpClient,
  preferred: string,
  resume: boolean,
  allowFallback: boolean,
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
    if (!allowFallback)
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
