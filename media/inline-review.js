import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import { overviewGeometry, scrollTopForOverview } from './review-overview.js';
import './inline-review.css';

const LINE_HEIGHT = 22;
const host = acquireVsCodeApi();
const root = document.getElementById('editor');
const status = document.getElementById('status');
const toolbar = document.getElementById('toolbar');
const overview = document.getElementById('overview');
const overviewSummary = document.getElementById('overview-summary');
let worker;
globalThis.MonacoEnvironment = {
  async getWorker() {
    worker ??= fetch(document.body.dataset.worker).then(async (response) => {
      if (!response.ok) throw new Error('Editor worker unavailable.');
      return URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
    });
    return new Worker(await worker);
  },
};

const editor = monaco.editor.create(root, {
  value: '',
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  contextmenu: false,
  links: false,
  colorDecorators: false,
  padding: { top: 16, bottom: 24 },
  lineHeight: LINE_HEIGHT,
  wordWrap: 'on',
  wrappingIndent: 'same',
});
const decorations = editor.createDecorationsCollection();
const zones = [];
const deletedZones = [];
const controls = [];
let state;
let applying = false;
let pendingText;
let forceSync = false;
let proposalTimer;

function token(styles, name, fallback) {
  return styles.getPropertyValue(name).trim() || fallback;
}

function theme() {
  const styles = getComputedStyle(document.body);
  monaco.editor.defineTheme('omp-review', {
    base: document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': token(styles, '--vscode-editor-background', '#1e1e1e'),
      'editor.foreground': token(styles, '--vscode-editor-foreground', '#d4d4d4'),
      'editor.selectionBackground': token(styles, '--vscode-editor-selectionBackground', '#264f78'),
      'editor.inactiveSelectionBackground': token(
        styles,
        '--vscode-editor-inactiveSelectionBackground',
        '#3a3d41',
      ),
      'editor.lineHighlightBackground': token(
        styles,
        '--vscode-editor-lineHighlightBackground',
        '#00000000',
      ),
      'editorGutter.background': token(styles, '--vscode-editorGutter-background', '#1e1e1e'),
      'editorOverviewRuler.border': token(
        styles,
        '--vscode-editorOverviewRuler-border',
        '#00000000',
      ),
    },
  });
  monaco.editor.setTheme('omp-review');
  editor.updateOptions({
    fontFamily: token(styles, '--vscode-editor-font-family', 'monospace'),
    fontSize: Number.parseInt(token(styles, '--vscode-editor-font-size', '13'), 10) || 13,
    wordWrap: 'on',
    wrappingIndent: 'same',
  });
  drawOverview();
}

function deletedLines(part, accessor) {
  const node = document.createElement('div');
  node.className = 'review-deleted';
  const lines = part.text.replace(/\r\n/g, '\n').split('\n');
  for (const [index, text] of lines.slice(0, part.count).entries()) {
    const row = document.createElement('div');
    const number = document.createElement('span');
    number.className = 'review-old-number';
    number.textContent = String(part.originalLine + index);
    const code = document.createElement('span');
    code.className = 'review-old-code';
    code.textContent = text;
    row.append(number, code);
    node.append(row);
  }
  const entry = { part, node, id: '', top: 0, height: part.count * LINE_HEIGHT, zone: undefined };
  entry.zone = {
    afterLineNumber: part.line - 1,
    heightInLines: part.count,
    domNode: node,
    suppressMouseDown: false,
    onDomNodeTop: (top) => {
      entry.top = top;
      drawOverview();
    },
  };
  entry.id = accessor.addZone(entry.zone);
  zones.push(entry.id);
  deletedZones.push(entry);
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => fitDeletedZone(entry));
}

function fitDeletedZone(entry) {
  if (!entry.id || !entry.node.isConnected) return;
  const measured = Math.max(entry.part.count * LINE_HEIGHT, entry.node.scrollHeight || 0);
  if (measured <= entry.height + 1) return;
  entry.height = measured;
  const previous = entry.id;
  editor.changeViewZones((accessor) => {
    accessor.removeZone(previous);
    entry.id = accessor.addZone({
      ...entry.zone,
      heightInLines: undefined,
      heightInPx: measured,
    });
    const index = zones.indexOf(previous);
    if (index >= 0) zones[index] = entry.id;
  });
  drawOverview();
}

function refitDeletedZones() {
  for (const entry of deletedZones) fitDeletedZone(entry);
}

function moveControls() {
  for (const control of controls) {
    control.node.style.top = `${control.top + 2}px`;
    control.node.hidden = control.top < 0 || control.top > root.clientHeight - 36;
  }
}

function glyph(label, icon) {
  const symbol = document.createElement('span');
  symbol.className = `codicon codicon-${icon}`;
  symbol.setAttribute('aria-hidden', 'true');
  return [symbol, document.createTextNode(label)];
}

function button(control, operation, label, icon) {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('aria-label', `${label} change`);
  element.title = `${label} change`;
  element.append(...glyph(label, icon));
  element.disabled = !state.available;
  element.onclick = () => {
    for (const item of controls)
      for (const child of item.node.querySelectorAll('button')) child.disabled = true;
    host.postMessage({
      type: 'reviewAction',
      changeId: state.changeId,
      revision: state.revision,
      hunkId: control.id,
      operation,
    });
  };
  return element;
}

function floating(hunk) {
  const node = document.createElement('div');
  node.className = 'review-controls';
  node.dataset.hunkId = hunk.id ?? '';
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', 'Change review');
  const control = { ...hunk, top: -10000, node };
  node.append(
    button(control, 'keep', 'Keep', 'check'),
    button(control, 'discard', 'Undo', 'discard'),
  );
  control.widget = {
    getId: () => `review-${hunk.id ?? 'file'}`,
    getDomNode: () => node,
    getPosition: () => null,
  };
  editor.addOverlayWidget(control.widget);
  controls.push(control);
  controlSpace(control);
}

function controlSpace(control) {
  const last = state.parts
    .filter((part) => part.hunkId === control.id)
    .reduce(
      (line, part) => Math.max(line, part.line + (part.kind === 'added' ? part.count : 0) - 1),
      0,
    );
  const space = document.createElement('div');
  space.setAttribute('aria-hidden', 'true');
  editor.changeViewZones((accessor) => {
    zones.push(
      accessor.addZone({
        afterLineNumber: Math.min(last, editor.getModel().getLineCount()),
        heightInPx: 38,
        domNode: space,
        onDomNodeTop: (top) => {
          control.top = top;
          moveControls();
        },
      }),
    );
  });
}

function actionButton(label, icon, action, description) {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset.action = action;
  element.title = description;
  element.append(...glyph(label, icon));
  return element;
}

const keepFile = actionButton('Keep file', 'check', 'keepFile', 'Keep the edited proposal');
const undoFile = actionButton('Undo file', 'discard', 'undoFile', 'Undo the whole change');
const resetFile = actionButton(
  'Reset to suggestion',
  'history',
  'resetFile',
  'Restore the agent proposal',
);
if (toolbar) toolbar.append(keepFile, undoFile, resetFile);

function disableActions() {
  for (const element of [keepFile, undoFile, resetFile]) element.disabled = true;
  for (const control of controls)
    for (const child of control.node.querySelectorAll('button')) child.disabled = true;
}

function syncToolbar(editing) {
  toolbar.hidden = !editing;
  const enabled = Boolean(state?.pending && state?.available && state?.editable);
  keepFile.disabled = !enabled;
  undoFile.disabled = !enabled;
  resetFile.disabled = !enabled;
}

function currentText() {
  return editor.getModel().getValue();
}

function cancelProposal() {
  clearTimeout(proposalTimer);
  pendingText = undefined;
}

keepFile.onclick = () => {
  if (!state) return;
  disableActions();
  cancelProposal();
  pendingText = currentText();
  host.postMessage({
    type: 'reviewAction',
    changeId: state.changeId,
    revision: state.revision,
    operation: 'keep',
    text: pendingText,
  });
};
undoFile.onclick = () => {
  if (!state) return;
  disableActions();
  cancelProposal();
  host.postMessage({
    type: 'reviewAction',
    changeId: state.changeId,
    revision: state.revision,
    operation: 'discard',
  });
};
resetFile.onclick = () => {
  if (!state) return;
  disableActions();
  cancelProposal();
  forceSync = true;
  host.postMessage({ type: 'reset', changeId: state.changeId, revision: state.revision });
};

function overviewMetrics() {
  const model = editor.getModel();
  const total =
    typeof editor.getScrollHeight === 'function'
      ? editor.getScrollHeight()
      : model.getLineCount() * LINE_HEIGHT;
  const layout = typeof editor.getLayoutInfo === 'function' ? editor.getLayoutInfo() : undefined;
  const viewport = layout?.height ?? root.clientHeight;
  const scroll = typeof editor.getScrollTop === 'function' ? editor.getScrollTop() : 0;
  return { total, viewport, scroll, model };
}

function drawOverview() {
  if (!state || !overview) return;
  const { total, viewport, scroll, model } = overviewMetrics();
  const lineTop = (line) =>
    typeof editor.getTopForLineNumber === 'function'
      ? editor.getTopForLineNumber(line, true)
      : (Math.max(1, line) - 1) * LINE_HEIGHT;
  const lineBottom = (line) =>
    typeof editor.getBottomForLineNumber === 'function'
      ? editor.getBottomForLineNumber(line)
      : lineTop(line) + LINE_HEIGHT;
  const markers = [];
  for (const part of state.parts ?? []) {
    if (part.kind === 'added') {
      const top = lineTop(part.line);
      const last = Math.min(part.line + part.count - 1, model.getLineCount());
      markers.push({ kind: 'added', top, height: Math.max(LINE_HEIGHT, lineBottom(last) - top) });
    } else {
      const entry = deletedZones.find((candidate) => candidate.part === part);
      const height = entry?.height ?? part.count * LINE_HEIGHT;
      const measured = entry && entry.top > -1_000_000;
      const top = measured ? entry.top + scroll : lineTop(part.line) - height;
      markers.push({ kind: 'removed', top: Math.max(0, top), height });
    }
  }
  const geometry = overviewGeometry(markers, total, viewport, scroll);
  const fragment = document.createDocumentFragment();
  for (const marker of geometry.markers) {
    const element = document.createElement('div');
    element.className = `overview-marker ${marker.kind}`;
    element.style.top = `${marker.top * 100}%`;
    element.style.height = `${marker.height * 100}%`;
    element.title = `${marker.kind} change`;
    fragment.append(element);
  }
  const thumb = document.createElement('div');
  thumb.className = 'overview-thumb';
  thumb.style.top = `${geometry.thumb.top * 100}%`;
  thumb.style.height = `${geometry.thumb.height * 100}%`;
  fragment.append(thumb);
  overview.replaceChildren(fragment);
  const added = geometry.markers.filter((marker) => marker.kind === 'added').length;
  const removed = geometry.markers.filter((marker) => marker.kind === 'removed').length;
  if (overviewSummary)
    overviewSummary.textContent = `${added} added regions, ${removed} removed regions.`;
}

function overviewRatio(event) {
  const box = overview.getBoundingClientRect();
  return box.height ? (event.clientY - box.top) / box.height : 0;
}

function overviewScroll(event) {
  const { total, viewport } = overviewMetrics();
  editor.setScrollTop(scrollTopForOverview(overviewRatio(event), total, viewport));
}

let dragging = false;
overview?.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  overview.setPointerCapture?.(event.pointerId);
  overviewScroll(event);
  event.preventDefault();
});
overview?.addEventListener('pointermove', (event) => {
  if (dragging) overviewScroll(event);
});
overview?.addEventListener('pointerup', (event) => {
  dragging = false;
  overview.releasePointerCapture?.(event.pointerId);
});
overview?.addEventListener('pointercancel', () => {
  dragging = false;
});
overview?.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const scroll = typeof editor.getScrollTop === 'function' ? editor.getScrollTop() : 0;
    editor.setScrollTop(Math.max(0, scroll + event.deltaY));
  },
  { passive: false },
);

function scheduleProposal() {
  clearTimeout(proposalTimer);
  proposalTimer = setTimeout(() => {
    if (!state || pendingText === undefined) return;
    host.postMessage({
      type: 'proposal',
      changeId: state.changeId,
      revision: state.revision,
      text: pendingText,
    });
  }, 180);
}

function render(next) {
  state = next;
  status.textContent = next.problem ?? '';
  status.hidden = !next.problem;
  const previous = editor.saveViewState();
  editor.changeViewZones((accessor) => {
    for (const zone of zones) accessor.removeZone(zone);
    zones.length = 0;
  });
  for (const control of controls) editor.removeOverlayWidget(control.widget);
  controls.length = 0;
  deletedZones.length = 0;
  const model = editor.getModel();
  const local = model.getValue();
  const syncText =
    local !== next.text && (forceSync || pendingText === undefined || next.text === pendingText);
  if (syncText) {
    applying = true;
    model.setValue(next.text);
    applying = false;
  }
  if (model.getValue() === next.text) pendingText = undefined;
  forceSync = false;
  const editing = Boolean(next.edited || pendingText !== undefined);
  editor.updateOptions({
    readOnly: !(next.pending && next.available && next.editable),
    domReadOnly: !(next.pending && next.available && next.editable),
  });
  syncToolbar(editing);
  setLanguage(model, next);
  decorate(next.parts);
  if (next.pending && !editing) {
    for (const hunk of reviewControls(next)) floating(hunk);
  }
  if (previous) editor.restoreViewState(previous);
  if (next.line) editor.revealLineInCenter(Math.min(next.line, model.getLineCount()));
  moveControls();
  drawOverview();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refitDeletedZones);
}

function setLanguage(model, next) {
  const language =
    next.language ??
    monaco.languages.getLanguages().find((entry) => entry.extensions?.includes(next.extension))
      ?.id ??
    'plaintext';
  monaco.editor.setModelLanguage(model, language);
}

function decorate(parts) {
  const additions = [];
  editor.changeViewZones((accessor) => {
    for (const part of parts) {
      if (part.kind === 'removed') deletedLines(part, accessor);
      else
        additions.push({
          range: new monaco.Range(part.line, 1, part.line + part.count - 1, 1),
          options: {
            isWholeLine: true,
            className: 'review-added',
            linesDecorationsClassName: 'review-add-mark',
          },
        });
    }
  });
  decorations.set(additions);
}

function reviewControls(next) {
  return next.hunks.length ? next.hunks : [{ line: next.parts[0]?.line ?? 1 }];
}

editor.onDidChangeModelContent(() => {
  if (applying || !state?.editable || !state.pending || !state.available) return;
  pendingText = currentText();
  state.edited = true;
  syncToolbar(true);
  for (const control of controls) control.node.hidden = true;
  scheduleProposal();
});
editor.onDidScrollChange(() => {
  moveControls();
  drawOverview();
});
editor.onDidLayoutChange(() => {
  moveControls();
  drawOverview();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refitDeletedZones);
});
editor.onDidChangeCursorPosition(({ position }) => {
  if (state)
    host.postMessage({
      type: 'cursor',
      changeId: state.changeId,
      revision: state.revision,
      line: position.lineNumber,
    });
});
new MutationObserver(theme).observe(document.body, {
  attributes: true,
  attributeFilter: ['class', 'style'],
});
window.addEventListener('message', ({ data }) => {
  if (data?.type === 'inlineReview') render(data);
});
window.addEventListener('unload', () => {
  clearTimeout(proposalTimer);
  editor.getModel()?.dispose();
  editor.dispose();
  worker?.then((url) => URL.revokeObjectURL(url));
});
theme();
host.postMessage({ type: 'ready' });
