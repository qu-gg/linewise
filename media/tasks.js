export function taskPanel(state, expanded, { escape, icon }) {
  const current = state.turns.at(-1);
  const plan = current?.blocks.find((block) => block.kind === 'plan' && block.entries);
  if (!plan?.entries.length) return '';
  const key = `tasks-${state.sessionId}`;
  const completed = plan.entries.filter((entry) => entry.status === 'completed').length;
  const statuses = {
    pending: ['circle-large-outline', 'Pending'],
    in_progress: ['circle-filled', 'In Progress'],
    completed: ['pass', 'Completed'],
  };
  return `<details class="task-list dock-section" data-disclosure="${escape(key)}" ${expanded[key] !== false ? 'open' : ''}><summary><span>Todos <span class="task-count">(${completed}/${plan.entries.length})</span></span></summary><ol>${plan.entries
    .map((entry) => {
      const [name, status] = statuses[entry.status] ?? statuses.pending;
      return `<li class="task-${escape(entry.status)}">${icon(name)}<span class="visually-hidden">${status}: </span><span>${escape(entry.content)}</span></li>`;
    })
    .join('')}</ol></details>`;
}
