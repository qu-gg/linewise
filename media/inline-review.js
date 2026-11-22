import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import './inline-review.css';

const host = acquireVsCodeApi();
const root = document.getElementById('editor');
const status = document.getElementById('status');
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
  lineHeight: 22,
});
const decorations = editor.createDecorationsCollection();
const zones = [];
const controls = [];
let state;

function theme() {
  const styles = getComputedStyle(document.body);
  monaco.editor.defineTheme('omp-review', {
    base: document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background':
        styles.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e',
      'editor.foreground':
        styles.getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4',
    },
  });
  monaco.editor.setTheme('omp-review');
  editor.updateOptions({
    fontFamily: styles.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace',
    fontSize: Number.parseInt(styles.getPropertyValue('--vscode-editor-font-size'), 10) || 13,
  });
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
  zones.push(
    accessor.addZone({
      afterLineNumber: part.line - 1,
      heightInLines: part.count,
      domNode: node,
      suppressMouseDown: false,
    }),
  );
}

function moveControls() {
  for (const control of controls) {
    control.node.style.top = `${control.top + 2}px`;
    control.node.hidden = control.top < 0 || control.top > root.clientHeight - 36;
  }
}

function button(control, operation, label, icon) {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('aria-label', `${label} change`);
  element.title = `${label} change`;
  const symbol = document.createElement('span');
  symbol.className = `codicon codicon-${icon}`;
  symbol.setAttribute('aria-hidden', 'true');
  element.append(symbol, document.createTextNode(label));
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
  const model = editor.getModel();
  if (model.getValue() !== next.text) model.setValue(next.text);
  setLanguage(model, next);
  decorate(next.parts);
  if (next.pending) {
    for (const hunk of reviewControls(next)) floating(hunk);
  }
  if (previous) editor.restoreViewState(previous);
  if (next.line) editor.revealLineInCenter(Math.min(next.line, model.getLineCount()));
  moveControls();
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

editor.onDidScrollChange(moveControls);
editor.onDidLayoutChange(moveControls);
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
  editor.getModel()?.dispose();
  editor.dispose();
  worker?.then((url) => URL.revokeObjectURL(url));
});
theme();
host.postMessage({ type: 'ready' });
