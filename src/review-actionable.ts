import type { Change } from './review-types.js';

/**
 * Mirrors the Local working-set projection: list only a live, non-identical
 * pending edit. Conflicts stay in the journal for recovery but are not
 * actionable Keep/Undo rows.
 */
export function actionableChange(change: Change): boolean {
  if (change.state !== 'pending') return false;
  if (change.destination) return change.before !== change.destination.after;
  return change.before !== change.after;
}
