import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PathGuard } from './path-guard.js';
import { hunkIdentities, resolveHunk, reviewHunks } from './review-hunks.js';
import type { Change, Provenance } from './review-types.js';
import { images, operationHistory } from './review-types.js';
export { PathGuard } from './path-guard.js';
export type { Change } from './review-types.js';

export interface TextFiles {
  read(target: string): Promise<string | null>;
  replace(target: string, expected: string | null, content: string | null): Promise<void>;
  preflightDelete?(target: string): Promise<void>;
  move?(source: string, destination: string, expected: string, content: string): Promise<void>;
}

type Image = Pick<Change, 'path' | 'before' | 'after'>;

export type Approval = (
  operation: {
    kind: 'read' | 'write' | 'delete' | 'move';
    path: string;
    before?: string | null;
    after?: string | null;
    destination?: string;
  },
  signal?: AbortSignal,
) => Promise<boolean>;

export class ReviewJournal {
  private changes: Change[];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly files: TextFiles,
    private readonly guard: PathGuard,
    private readonly approve: Approval,
    private readonly persist: (changes: readonly Change[]) => Promise<void>,
    initial: readonly Change[] = [],
  ) {
    this.changes = structuredClone(initial) as Change[];
  }

  list(sessionId?: string): Change[] {
    return this.changes
      .filter((change) => !sessionId || change.sessionId === sessionId)
      .map((change) => structuredClone(change));
  }

  async read(target: string, signal?: AbortSignal): Promise<string> {
    const content = await this.inspect(target, signal);
    if (content === null) throw new Error('File does not exist.');
    return content;
  }

  async inspect(target: string, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    const scope = await this.guard.resolve(target);
    if (!scope.inside && !(await this.approve({ kind: 'read', path: scope.path }, signal))) {
      throw new Error('Outside-workspace read was not approved.');
    }
    signal?.throwIfAborted();
    await this.revalidate(target, scope.path);
    return this.files.read(scope.path);
  }

  write(
    sessionId: string,
    target: string,
    content: string,
    signal?: AbortSignal,
    expected?: string | null,
    provenance?: Provenance,
  ): Promise<void> {
    return this.setContent(sessionId, target, content, signal, expected, provenance);
  }

  delete(
    sessionId: string,
    target: string,
    signal?: AbortSignal,
    expected?: string,
    provenance?: Provenance,
  ): Promise<void> {
    return this.setContent(sessionId, target, null, signal, expected, provenance);
  }

  private setContent(
    sessionId: string,
    target: string,
    content: string | null,
    signal?: AbortSignal,
    expected?: string | null,
    provenance?: Provenance,
  ): Promise<void> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (content !== null) this.checkText(content);
      const { path: approved, previous } = await this.authorizeWrite(target, content, signal);
      if (expected !== undefined && expected !== previous)
        throw new Error('Native edit preimage is stale.');
      if (content === null) {
        if (previous === null) throw new Error('Cannot delete a missing file.');
        await this.files.preflightDelete?.(approved);
      }
      const change = await this.prepareChange(sessionId, approved, previous, content, provenance);
      await this.commit(change, [{ path: approved, before: previous, after: content }], signal);
    });
  }

  move(
    sessionId: string,
    source: string,
    destination: string,
    signal?: AbortSignal,
    edit?: { before: string; after: string },
    provenance?: Provenance,
  ): Promise<void> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const { from, to, previous, content } = await this.movePreimages(source, destination, edit);
      if (
        (!from.inside || !to.inside) &&
        !(await this.approve(
          {
            kind: 'move',
            path: from.path,
            destination: to.path,
            before: previous,
            after: content,
          },
          signal,
        ))
      )
        throw new Error('Outside-workspace move was not approved.');
      signal?.throwIfAborted();
      await this.revalidate(source, from.path);
      await this.revalidate(destination, to.path);
      const change = await this.prepareChange(
        sessionId,
        from.path,
        previous,
        null,
        provenance,
        true,
      );
      change.destination = { path: to.path, before: null, after: content };
      change.intermediate = previous;
      change.incomplete = true;
      await this.commit(
        change,
        [change.destination, { path: from.path, before: previous, after: null }],
        signal,
      );
    });
  }

  private async movePreimages(
    source: string,
    destination: string,
    edit?: { before: string; after: string },
  ) {
    const from = await this.guard.resolve(source);
    const to = await this.guard.resolve(destination);
    this.noAlias(source, from.path);
    this.noAlias(destination, to.path);
    if (from.path === to.path) throw new Error('Move source and destination must differ.');
    const previous = await this.files.read(from.path);
    if (previous === null) throw new Error('Cannot move a missing file.');
    if (edit && edit.before !== previous) throw new Error('Native edit preimage is stale.');
    const content = edit?.after ?? previous;
    this.checkText(previous);
    this.checkText(content);
    await this.files.preflightDelete?.(from.path);
    if ((await this.files.read(to.path)) !== null)
      throw new Error('Move destination already exists.');
    if (this.changes.some((change) => images(change).some((image) => image.path === to.path)))
      throw new Error('Resolve the destination in its owning session before moving.');
    return { from, to, previous, content };
  }

  private async commit(change: Change, expected: Image[], signal?: AbortSignal): Promise<void> {
    for (const image of expected)
      if ((await this.files.read(image.path)) !== image.before)
        throw new Error('File changed while approval was pending.');
    this.changes = [...this.changes.filter((candidate) => candidate.id !== change.id), change];
    await this.persist(this.list());
    if (change.destination && this.files.move) {
      signal?.throwIfAborted();
      for (const image of expected) await this.revalidate(image.path, image.path);
      await this.files.move(
        change.path,
        change.destination.path,
        change.intermediate!,
        change.destination.after,
      );
      for (const image of expected) await this.verifyImage(change, image);
    } else await this.applyImages(change, expected, signal);
    change.state = 'pending';
    if (change.destination) change.incomplete = false;
    if (images(change).every((image) => image.before === image.after))
      this.changes = this.changes.filter((candidate) => candidate.id !== change.id);
    await this.persist(this.list());
  }

  private async applyImages(
    change: Change,
    expected: Image[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const image of expected) {
      signal?.throwIfAborted();
      await this.revalidate(image.path, image.path);
      await this.files.replace(image.path, image.before, image.after);
      await this.verifyImage(change, image);
    }
  }

  private async verifyImage(change: Change, image: Image): Promise<void> {
    if ((await this.files.read(image.path)) === image.after) return;
    change.state = 'conflict';
    await this.persist(this.list());
    throw new Error('Save participants changed the file; inspect the conflict before continuing.');
  }

  keep(id: string): Promise<void> {
    return this.serial(async () => {
      const change = this.find(id);
      this.changes = this.changes.filter((candidate) => candidate.id !== change.id);
      await this.persist(this.list());
    });
  }

  resolveHunk(id: string, hunkId: string, action: 'keep' | 'discard'): Promise<void> {
    return this.serial(async () => {
      const change = this.find(id);
      const resolved = resolveHunk(change, hunkId, action);
      await this.revalidate(change.path, change.path);
      if ((await this.files.read(change.path)) !== change.after) {
        change.state = 'conflict';
        await this.persist(this.list());
        throw new Error('Cannot resolve hunk: the file has newer user or external changes.');
      }
      change.hunkIntent = resolved;
      change.state = 'applying';
      await this.persist(this.list());
      if (action === 'discard') await this.files.replace(change.path, change.after, resolved.after);
      await this.verifyImage(change, {
        path: change.path,
        before: change.after,
        after: resolved.after,
      });
      Object.assign(change, resolved);
      delete change.hunkIntent;
      change.state = 'pending';
      if (change.before === change.after)
        this.changes = this.changes.filter((candidate) => candidate.id !== id);
      await this.persist(this.list());
    });
  }

  refresh(): Promise<void> {
    return this.serial(async () => {
      let updated = false;
      for (const change of [...this.changes]) {
        const state = await this.recoveredState(change);
        if (state === null) {
          this.changes = this.changes.filter((candidate) => candidate.id !== change.id);
          updated = true;
        } else if (change.state !== state) {
          change.state = state;
          updated = true;
        }
      }
      if (updated) await this.persist(this.list());
    });
  }

  discard(id: string): Promise<void> {
    return this.serial(async () => {
      const change = this.find(id);
      if (change.destination) return this.discardMove(change);
      await this.revalidate(change.path, change.path);
      if ((await this.files.read(change.path)) !== change.after) {
        change.state = 'conflict';
        await this.persist(this.list());
        throw new Error('Cannot discard: the file has newer user or external changes.');
      }
      await this.files.replace(change.path, change.after, change.before);
      this.changes = this.changes.filter((candidate) => candidate.id !== change.id);
      await this.persist(this.list());
    });
  }

  private async discardMove(change: Change): Promise<void> {
    const expected: { image: Image; current: string | null }[] = [];
    for (const image of images(change).reverse()) {
      await this.revalidate(image.path, image.path);
      const current = await this.files.read(image.path);
      if (!this.knownMoveImage(change, image, current)) {
        change.state = 'conflict';
        await this.persist(this.list());
        throw new Error('Cannot discard: the move has newer user or external changes.');
      }
      expected.push({ image, current });
    }
    change.resolving = true;
    await this.persist(this.list());
    await this.restoreMove(change, expected);
    this.changes = this.changes.filter((candidate) => candidate.id !== change.id);
    await this.persist(this.list());
  }

  private knownMoveImage(change: Change, image: Image, current: string | null): boolean {
    if (current === image.after) return true;
    if (!change.incomplete && !change.resolving) return false;
    return (
      current === image.before ||
      current === change.intermediate ||
      !!(change.resolving && image.path === change.path && current === change.destination!.after)
    );
  }

  private async restoreMove(
    change: Change,
    expected: { image: Image; current: string | null }[],
  ): Promise<void> {
    if (
      this.files.move &&
      change.before !== null &&
      expected[0]!.current === null &&
      expected[1]!.current !== null
    ) {
      await this.files.move(
        change.destination!.path,
        change.path,
        expected[1]!.current!,
        change.before,
      );
      for (const { image } of expected)
        if ((await this.files.read(image.path)) !== image.before)
          throw new Error('Restoration changed the file; both move records remain available.');
      return;
    }
    for (const { image, current } of expected) {
      await this.revalidate(image.path, image.path);
      if (current !== image.before) await this.files.replace(image.path, current, image.before);
      if ((await this.files.read(image.path)) !== image.before)
        throw new Error('Restoration changed the file; both move records remain available.');
    }
  }

  private find(id: string): Change {
    const change = this.changes.find((candidate) => candidate.id === id);
    if (!change) throw new Error('Unknown or already resolved change.');
    return change;
  }

  private async authorizeWrite(
    target: string,
    content: string | null,
    signal?: AbortSignal,
  ): Promise<{ path: string; previous: string | null }> {
    const scope = await this.guard.resolve(target);
    if (content === null) this.noAlias(target, scope.path);
    const previous = await this.files.read(scope.path);
    if (previous !== null) this.checkText(previous);
    if (
      !scope.inside &&
      !(await this.approve(
        {
          kind: content === null ? 'delete' : 'write',
          path: scope.path,
          before: previous,
          after: content,
        },
        signal,
      ))
    ) {
      throw new Error('Outside-workspace write was not approved.');
    }
    signal?.throwIfAborted();
    await this.revalidate(target, scope.path);
    if ((await this.files.read(scope.path)) !== previous)
      throw new Error('File changed while approval was pending.');
    return { path: scope.path, previous };
  }

  private async prepareChange(
    sessionId: string,
    target: string,
    previous: string | null,
    content: string | null,
    provenance?: Provenance,
    moving = false,
  ): Promise<Change> {
    const prior = await this.priorChange(sessionId, target, previous);
    const change: Change = {
      id: prior?.id ?? randomUUID(),
      sessionId,
      path: target,
      before: prior ? prior.before : previous,
      after: content,
      state: 'applying',
      updatedAt: Date.now(),
      operations: operationHistory(prior, previous, content, provenance, moving),
    };
    change.hunkIds = hunkIdentities(change, prior ? reviewHunks(prior) : []);
    return change;
  }

  private async priorChange(sessionId: string, target: string, previous: string | null) {
    const prior = this.changes.find(
      (change) =>
        images(change).some((image) => image.path === target) && change.sessionId === sessionId,
    );
    if (prior?.destination) throw new Error('Resolve the paired move before editing either path.');
    if (
      this.changes.some(
        (change) =>
          images(change).some((image) => image.path === target) && change.sessionId !== sessionId,
      )
    ) {
      throw new Error(
        'Resolve this file in its owning session before editing it from another session.',
      );
    }
    if (prior && (prior.after !== previous || prior.state === 'conflict')) {
      prior.state = 'conflict';
      await this.persist(this.list());
      throw new Error('File has newer changes; resolve its pending review first.');
    }
    if (prior?.hunkIntent)
      throw new Error('Recover the interrupted hunk operation before editing.');
    return prior;
  }

  private async recoveredState(change: Change): Promise<Change['state'] | null> {
    try {
      if (change.destination) {
        return await this.recoveredMoveState(change);
      }
      const current = await this.files.read(change.path);
      if (change.hunkIntent && change.state !== 'conflict') {
        return this.recoveredHunkState(change, current);
      }
      if (change.state === 'applying' && current === change.before) return null;
      return current === change.after && change.state !== 'conflict' ? 'pending' : 'conflict';
    } catch {
      return 'conflict';
    }
  }

  private recoveredHunkState(change: Change, current: string | null): Change['state'] | null {
    if (current === change.hunkIntent!.after) Object.assign(change, change.hunkIntent);
    else if (current !== change.after) return 'conflict';
    delete change.hunkIntent;
    return change.before === change.after ? null : 'pending';
  }

  private async recoveredMoveState(change: Change): Promise<Change['state'] | null> {
    const values = await Promise.all(
      images(change).map(async (image) => ({ image, current: await this.files.read(image.path) })),
    );
    if (
      values.every(({ image, current }) => current === image.before) &&
      (change.state === 'applying' || change.resolving)
    )
      return null;
    return values.every(({ image, current }) => current === image.after) &&
      !change.resolving &&
      change.state !== 'conflict'
      ? 'pending'
      : 'conflict';
  }

  private async revalidate(requested: string, expected: string): Promise<void> {
    if ((await this.guard.resolve(requested)).path !== expected)
      throw new Error('Target path changed during the operation.');
  }

  private noAlias(requested: string, resolved: string): void {
    if (path.resolve(requested) !== resolved)
      throw new Error('Destructive symbolic-link aliases are not supported.');
  }

  private checkText(content: string): void {
    if (content.includes('\0') || Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
      throw new Error('Binary or oversized text changes are not supported.');
    }
  }

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
}
