let display = {
  open: false,
  loading: false,
  filter: '',
  groups: [],
  current: '',
  active: 0,
  scroll: 0,
};

const lower = (value) => String(value ?? '').toLocaleLowerCase();

function matches(model, provider, tokens) {
  const text = lower([model.name, model.value, model.description, provider].join(' '));
  return tokens.every((token) => text.includes(token));
}

function visibleGroups() {
  const tokens = lower(display.filter).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return display.groups;
  return display.groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => matches(model, group.provider, tokens)),
    }))
    .filter((group) => group.models.length);
}

function flatten(groups) {
  return groups.flatMap((group) =>
    group.models.map((model) => ({ ...model, provider: group.provider })),
  );
}

function activeIndex(options) {
  if (!options.length) return -1;
  return Math.min(Math.max(display.active, 0), options.length - 1);
}

function modelConfig(state) {
  return state.configs.find((config) => config.id === 'model');
}

function selectCurrent(render) {
  const options = flatten(visibleGroups());
  const index = options.findIndex((model) => model.value === display.current);
  display.active = index >= 0 ? index : 0;
  display.scroll = 0;
  render();
}

function routeLabel(state, model) {
  const route = state.modelRoute;
  if (!route || !route.value || route.value === 'auto') return model.route?.label;
  return route.options?.find((option) => option.value === route.value)?.name ?? model.route?.label;
}

function modelLabel(state, model) {
  const via = routeLabel(state, model);
  return `${model.label ?? model.value}${via ? ` · via ${via}` : ''}`;
}

export function modelPicker(state, { escape, icon, working }) {
  const model = modelConfig(state);
  if (!model) return '';
  const label = modelLabel(state, model);
  const trigger = `<button type="button" id="model-picker" class="model-picker" data-action="pickModel" title="${escape(model.value)}" aria-label="Model: ${escape(label)}" aria-haspopup="listbox" aria-expanded="${display.open}" ${working() ? 'disabled' : ''}>${icon('symbol-method')}<span class="model-name">${escape(label)}</span>${icon('chevron-down')}</button>`;
  return `<div class="model-control">${trigger}</div>`;
}

export function modelRoutePicker(state, { escape, working }) {
  const route = state.modelRoute;
  if (!route?.visible || !route.options?.length) return '';
  const selected = route.options.find((option) => option.value === route.value);
  const title =
    selected?.description ??
    (route.loading
      ? 'Loading OpenRouter providers...'
      : 'OpenRouter provider routing for this new chat');
  return `<select id="model-route" class="model-route" data-route="1" aria-label="OpenRouter provider" title="${escape(title)}" ${working() ? 'disabled' : ''}>${route.options.map((option) => `<option value="${escape(option.value)}" title="${escape(option.description ?? option.name)}" ${option.value === route.value ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>${escape(option.name)}</option>`).join('')}</select>`;
}

export function modelPickerPopover(state, { escape, icon }) {
  if (!display.open || !modelConfig(state)) return '';
  const groups = visibleGroups();
  const options = flatten(groups);
  const active = activeIndex(options);
  display.active = active;
  let index = 0;
  const groupsHtml = groups
    .map((group) => {
      const models = group.models
        .map((choice) => {
          const option = index++;
          const selected = choice.value === display.current;
          const current = option === active ? ' active' : '';
          return `<div id="model-option-${option}" role="option" class="model-option${current}" data-model="${escape(choice.value)}" aria-selected="${selected}"><span class="model-option-name">${escape(choice.name)}</span><span class="model-option-id">${escape(choice.description ?? choice.value)}</span>${selected ? icon('check') : ''}</div>`;
        })
        .join('');
      const count =
        group.models.length === group.count ? group.count : `${group.models.length}/${group.count}`;
      return `<div class="model-group" role="group" aria-label="${escape(group.provider)}"><div class="model-provider" aria-hidden="true"><span>${escape(group.provider)}</span><span>${count}</span></div>${models}</div>`;
    })
    .join('');
  let status = '';
  if (display.loading && !display.groups.length)
    status = '<p class="model-empty" role="status">Loading models...</p>';
  else if (!display.groups.length)
    status =
      '<p class="model-empty" role="status">No OMP models are available. Run omp in a terminal and use /login for a provider.</p>';
  else if (!options.length)
    status = `<p class="model-empty" role="status">No models match &quot;${escape(display.filter)}&quot;.</p>`;
  const activeId = active >= 0 ? `model-option-${active}` : '';
  return `<div class="model-popover" role="dialog" aria-label="Select Model"><label class="model-search">${icon('search')}<input id="model-search" type="search" role="combobox" aria-label="Search models" aria-autocomplete="list" aria-expanded="true" aria-controls="model-list" aria-activedescendant="${activeId}" placeholder="Search models by name, provider, or ID" value="${escape(display.filter)}"></label><div id="model-list" class="model-list" role="listbox" aria-label="Models">${groupsHtml}</div>${status}<p class="model-note">Switching providers sends future prompts and conversation context to that provider. Credentials stay in OMP.</p></div>`;
}

let bound = false;

export function bindModelPicker(send, render) {
  if (bound) return;
  bound = true;
  document.addEventListener('click', (event) => {
    const choice = event.target.closest?.('[data-model]');
    if (choice) {
      selectModelFromPicker(choice.dataset.model, send, render);
      return;
    }
    if (display.open && !event.target.closest?.('.model-popover, #model-picker'))
      closeModelPicker(render, false);
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'model-search') filterModelPicker(event.target.value, render);
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.id === 'model-search' && modelPickerKeydown(event, send, render)) return;
    if (event.key === 'Escape' && display.open) {
      event.preventDefault();
      closeModelPicker(render);
    }
  });
  window.addEventListener('message', (event) => {
    if (event.data?.v === 1 && event.data.type === 'modelCatalog')
      receiveModelCatalog(event.data, render);
  });
}

export function modelPickerOpen() {
  return display.open;
}

export function openModelPicker(send, render) {
  display.open = true;
  display.loading = true;
  display.filter = '';
  display.active = 0;
  display.scroll = 0;
  send('modelCatalog');
  selectCurrent(render);
  requestAnimationFrame(() =>
    document.querySelector('#model-search')?.focus({ preventScroll: true }),
  );
}

export function closeModelPicker(render, restore = true) {
  if (!display.open) return;
  display.open = false;
  display.loading = false;
  display.filter = '';
  display.active = 0;
  render();
  if (restore)
    requestAnimationFrame(() =>
      document.querySelector('#model-picker')?.focus({ preventScroll: true }),
    );
}

export function receiveModelCatalog(message, render) {
  display.loading = false;
  display.groups = Array.isArray(message.groups) ? message.groups : [];
  display.current = typeof message.current === 'string' ? message.current : '';
  if (!display.open) return;
  selectCurrent(render);
  requestAnimationFrame(() =>
    document.querySelector('#model-search')?.focus({ preventScroll: true }),
  );
}

export function filterModelPicker(value, render) {
  display.filter = value;
  selectCurrent(render);
}

export function selectModelFromPicker(value, send, render) {
  send('config', { id: 'model', value });
  closeModelPicker(render);
}

function moveActive(key, count) {
  const active = activeIndex(flatten(visibleGroups()));
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return (active + (key === 'ArrowDown' ? 1 : -1) + count) % count;
}

export function modelPickerKeydown(event, send, render) {
  if (!display.open) return false;
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    closeModelPicker(render);
    return true;
  }
  const options = flatten(visibleGroups());
  if (event.key === 'Enter') {
    event.preventDefault();
    const choice = options[activeIndex(options)];
    if (choice) selectModelFromPicker(choice.value, send, render);
    return true;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !options.length) return false;
  event.preventDefault();
  display.active = moveActive(event.key, options.length);
  render();
  return true;
}

export function refreshModelPicker(root) {
  if (!display.open) return;
  const list = root.querySelector('#model-list');
  if (!list) return;
  list.scrollTop = display.scroll;
  list.addEventListener('scroll', () => (display.scroll = list.scrollTop), { passive: true });
  root.querySelector('.model-option.active')?.scrollIntoView?.({ block: 'nearest' });
}
