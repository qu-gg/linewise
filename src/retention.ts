import { createHash } from 'node:crypto';
import { inspectStorage, planSessionRemoval } from './storage.js';
import {
  assertKnownOwnership,
  readArtifact,
  removeArtifacts,
  retentionPolicy,
  scanArtifacts,
  writePrivateExport,
} from './storage-files.js';
import type { StateStore } from './state.js';

export function retentionCandidates(store: StateStore, now = Date.now()) {
  const inventory = inspectStorage(store.data);
  let retainedBytes = inventory.serializedStateBytes;
  const candidates: string[] = [];
  const eligible = inventory.sessions
    .filter((saved) => !saved.protectedBy.length && saved.lastActivityAt !== undefined)
    .sort((left, right) => left.lastActivityAt! - right.lastActivityAt!);
  for (const saved of eligible) {
    const expired = now - saved.lastActivityAt! >= retentionPolicy.inactiveDays * 86400000;
    if (expired || retainedBytes > retentionPolicy.maximumStateBytes) {
      candidates.push(saved.id);
      retainedBytes -= saved.serializedBytes;
    }
  }
  return { candidates, retainedBytes, limits: retentionPolicy };
}

function revision(store: StateStore): string {
  return createHash('sha256').update(JSON.stringify(store.data)).digest('hex');
}

export class StorageMaintenance {
  constructor(readonly store: StateStore) {}

  async inspect() {
    const artifacts = await scanArtifacts(this.store);
    return {
      ...inspectStorage(this.store.data),
      nativeArtifactSizes: 'regular-jsonl-only',
      nativeArtifactBytes: artifacts.reduce((sum, file) => sum + file.size, 0),
      artifacts,
      retentionPlan: retentionCandidates(this.store),
    };
  }

  async planRemoval(ids: readonly string[]) {
    if (ids.length > retentionPolicy.maximumRemovalFiles)
      throw new Error('Select at most 128 sessions per removal.');
    const selected = planSessionRemoval(this.store.data, ids);
    const artifacts = await scanArtifacts(this.store);
    const removed = new Set(ids);
    const removable = artifacts.filter(
      (file) => file.owners.length > 0 && file.owners.every((id) => removed.has(id)),
    );
    if (removable.length > retentionPolicy.maximumRemovalFiles)
      throw new Error('Select fewer sessions; native cleanup is limited to 128 artifacts.');
    return {
      ids: [...ids],
      revision: revision(this.store),
      labels: selected.map((saved) => saved.label),
      artifacts: removable,
    };
  }

  async remove(plan: Awaited<ReturnType<StorageMaintenance['planRemoval']>>) {
    await this.store.updateSessions((data) => {
      if (revision(this.store) !== plan.revision)
        throw new Error('Storage changed; select sessions again.');
      planSessionRemoval(data, plan.ids);
      const selected = new Set(plan.ids);
      return data.sessions.filter((saved) => !selected.has(saved.id));
    });
    try {
      return {
        removedSessions: plan.ids,
        removedArtifacts: await removeArtifacts(this.store, plan.artifacts),
      };
    } catch (error) {
      throw new Error(
        'Sessions were removed, but some native artifacts remain. Inspect storage and retry orphan cleanup.',
        { cause: error },
      );
    }
  }

  async orphans(now = Date.now()) {
    assertKnownOwnership(this.store);
    const inventory = inspectStorage(this.store.data);
    if (
      inventory.missingSessionIds.length ||
      this.store.data.sessions.some((saved) => saved.historyTransition)
    )
      throw new Error(
        'Resolve incomplete storage references and history recovery before orphan cleanup.',
      );
    return (await scanArtifacts(this.store))
      .filter(
        (file) =>
          !file.owners.length && now - file.modifiedAt >= retentionPolicy.inactiveDays * 86400000,
      )
      .slice(0, retentionPolicy.maximumRemovalFiles);
  }

  async cleanupOrphans(selected: Awaited<ReturnType<StorageMaintenance['orphans']>>) {
    const eligible = new Set((await this.orphans()).map((file) => file.name));
    if (selected.some((file) => !eligible.has(file.name)))
      throw new Error('Orphan eligibility changed.');
    return removeArtifacts(this.store, selected);
  }

  async exportSession(id: string, destination: string): Promise<void> {
    const selected = this.store.data.sessions.find((saved) => saved.id === id);
    if (!selected) throw new Error('The selected session no longer exists.');
    const before = revision(this.store);
    const files = (await scanArtifacts(this.store)).filter((file) => file.owners.includes(id));
    const review = this.store.data.changes.filter((change) => change.sessionId === id);
    let bytes = Buffer.byteLength(JSON.stringify({ session: selected, review })) + 1024;
    if (files.reduce((sum, file) => sum + file.size, bytes) > retentionPolicy.maximumExportBytes)
      throw new Error('Session exceeds the bounded export budget.');
    const artifacts = [];
    for (const file of files) {
      const artifact = { name: file.name, contents: await readArtifact(this.store, file) };
      bytes += Buffer.byteLength(JSON.stringify(artifact)) + 1;
      if (bytes > retentionPolicy.maximumExportBytes)
        throw new Error('Session exceeds the bounded export budget.');
      artifacts.push(artifact);
    }
    if (before !== revision(this.store))
      throw new Error('Storage changed during export; retry while idle.');
    const contents = JSON.stringify({
      format: 'vs-omp-session',
      version: 1,
      restoreSupported: false,
      session: selected,
      review,
      artifacts,
    });
    await writePrivateExport(destination, contents);
  }
}
