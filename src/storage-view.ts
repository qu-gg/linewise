import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { StateStore } from './state.js';
import { reconcileActiveSession } from './sessions.js';
import { planSessionRemoval } from './storage.js';
import { StorageMaintenance, retentionCandidates } from './retention.js';
import { retentionPolicy } from './storage-policy.js';

type StorageRunner = (action: () => Promise<void>) => Promise<void>;

async function confirm(action: string, detail: string): Promise<boolean> {
  return (
    (await vscode.window.showWarningMessage(action, { modal: true, detail }, 'Continue')) ===
    'Continue'
  );
}

async function chooseSession(store: StateStore, removable: boolean) {
  const sessions = store.data.sessions.filter((saved) => {
    if (!removable) return true;
    try {
      planSessionRemoval(store.data, [saved.id]);
      return true;
    } catch {
      return false;
    }
  });
  if (!sessions.length) {
    await vscode.window.showInformationMessage('No eligible OMP sessions.');
    return undefined;
  }
  return vscode.window.showQuickPick(
    sessions.map((saved) => ({
      label: saved.label || 'Untitled session',
      description: saved.id,
      id: saved.id,
    })),
    { title: removable ? 'Delete OMP Session' : 'Export OMP Session' },
  );
}

async function exportSession(service: StorageMaintenance) {
  const picked = await chooseSession(service.store, false);
  if (!picked) return;
  const destination = await vscode.window.showSaveDialog({
    title: 'Export OMP Session',
    filters: { JSON: ['json'] },
  });
  if (!destination) return;
  if (destination.scheme !== 'file') throw new Error('Choose a local file on this workspace host.');
  if (
    !(await confirm(
      'Export private OMP session data?',
      `Includes full prompts, attachments, native history and review images. Inspection JSON only, not a resumable backup. New file: ${destination.fsPath}`,
    ))
  )
    return;
  await service.exportSession(picked.id, destination.fsPath);
  await vscode.window.showInformationMessage('OMP session exported.');
}

async function removeSessions(service: StorageMaintenance, retention: boolean) {
  const picked = retention ? undefined : await chooseSession(service.store, true);
  const ids = retention
    ? retentionCandidates(service.store).candidates.slice(0, retentionPolicy.maximumRemovalFiles)
    : picked
      ? [picked.id]
      : [];
  if (!ids.length) {
    if (retention) await vscode.window.showInformationMessage('No eligible retention candidates.');
    return;
  }
  const plan = await service.planRemoval(ids);
  if (
    !(await confirm(
      'Permanently remove OMP sessions?',
      `${plan.labels.join('\n')}\n${plan.artifacts.length} native artifacts. Files and shared memory are not changed. Export first; deletion cannot be undone.`,
    ))
  )
    return;
  await service.remove(plan);
  await vscode.window.showInformationMessage(`Removed ${plan.ids.length} OMP sessions.`);
}

async function cleanOrphans(service: StorageMaintenance) {
  const candidates = await service.orphans();
  if (!candidates.length) {
    await vscode.window.showInformationMessage('No eligible orphan artifacts.');
    return;
  }
  if (
    await confirm(
      'Permanently remove old unreferenced native artifacts?',
      candidates.map((file) => file.name).join('\n'),
    )
  ) {
    await service.cleanupOrphans(candidates);
    await vscode.window.showInformationMessage(`Removed ${candidates.length} native artifacts.`);
  }
}

export async function initializeStorage(
  context: vscode.ExtensionContext,
  runner?: StorageRunner,
): Promise<StateStore> {
  const store = new StateStore((context.storageUri ?? context.globalStorageUri).fsPath);
  await store.load();
  reconcileActiveSession(store.data);
  const service = new StorageMaintenance(store);
  const run = (action: () => Promise<void>) => {
    if (!runner || vscode.env.remoteName || process.platform !== 'linux')
      throw new Error('Storage maintenance requires the supported local Linux host.');
    return runner(action);
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('omp-storage', {
      provideTextDocumentContent: async () =>
        JSON.stringify(
          {
            storageDirectory: store.directory,
            scope: 'current-host-state',
            ...(await service.inspect()),
          },
          null,
          2,
        ),
    }),
    vscode.commands.registerCommand('omp.inspectStorage', async () => {
      const uri = vscode.Uri.parse(`omp-storage:/inventory.json?snapshot=${randomUUID()}`);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand('omp.exportSession', () => run(() => exportSession(service))),
    vscode.commands.registerCommand('omp.deleteSession', () =>
      run(() => removeSessions(service, false)),
    ),
    vscode.commands.registerCommand('omp.applyRetention', () =>
      run(() => removeSessions(service, true)),
    ),
    vscode.commands.registerCommand('omp.cleanupStorage', () => run(() => cleanOrphans(service))),
  );
  return store;
}
