export function reviewRequest(target) {
  return target.dataset.id ? { id: target.dataset.id } : {};
}

export function changesPanel(state, expanded, { escape, icon, itemButton }) {
  if (!state.changes.length) return '';
  const working = state.busy || state.connecting;
  const added = state.changes.reduce((total, change) => total + change.added, 0);
  const removed = state.changes.reduce((total, change) => total + change.removed, 0);
  const changes = state.changes
    .map((change) => {
      const parts = change.name.split('/');
      const name = parts.pop();
      const folder = parts.join('/');
      const extension = name.split('.').at(-1)?.toLowerCase();
      const type = ['ts', 'tsx'].includes(extension)
        ? 'TS'
        : ['js', 'mjs', 'jsx', 'cjs'].includes(extension)
          ? 'JS'
          : undefined;
      const status = { create: 'diff-added', delete: 'diff-removed', rename: 'diff-renamed' }[
        change.kind
      ];
      return `<div class="file-review"><div class="change"><button type="button" class="file-link" data-action="review" data-id="${escape(change.id)}" title="Review ${escape(change.name)}">${change.state === 'conflict' ? icon('warning') : status ? icon(status) : type ? `<span class="file-type ${type.toLowerCase()}">${type}</span>` : icon('file-code')}<span class="file-name">${escape(name)}</span><span class="file-folder">${escape(folder)}</span></button><span class="file-counts"><span class="added">+${change.added}</span><span class="removed">-${change.removed}</span></span><span class="file-actions">${itemButton('keep', 'check', 'Keep File', change.id)}${itemButton('discard', 'discard', 'Discard File', change.id)}</span></div></div>`;
    })
    .join('');
  return `<details class="changes" data-disclosure="changed-files" ${expanded['changed-files'] !== false ? 'open' : ''}><summary><span class="changes-count">${state.changes.length} file${state.changes.length === 1 ? '' : 's'} changed</span><span class="added">+${added}</span><span class="removed">-${removed}</span><span class="review-actions"><button type="button" class="keep-all" data-action="keepAll" title="Keep All Files" ${working ? 'disabled' : ''}>Keep</button><button type="button" class="undo-all" data-action="discardAll" title="Undo All File Changes" ${working ? 'disabled' : ''}>Undo</button></span></summary><div class="change-list">${changes}</div></details>`;
}
