import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard, ReviewJournal } from '../review.js';
import type { Change, TextFiles } from '../review.js';

export async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vs-omp-review-'));
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const data = new Map<string, string>();
  const files: TextFiles = {
    read: async (target) => data.get(target) ?? null,
    replace: async (target, expected, content) => {
      assert.equal(data.get(target) ?? null, expected);
      if (content === null) data.delete(target);
      else data.set(target, content);
    },
  };
  let saved: readonly Change[] = [];
  let approvals = 0;
  let allowed = false;
  const journal = new ReviewJournal(
    files,
    new PathGuard([root]),
    async () => {
      approvals++;
      return allowed;
    },
    async (changes) => {
      saved = structuredClone(changes);
    },
  );
  return {
    directory,
    root,
    data,
    files,
    journal,
    saved: () => saved,
    approvals: () => approvals,
    allow: () => {
      allowed = true;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
